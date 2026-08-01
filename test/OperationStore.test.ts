import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { OperationStore, OPERATIONS_SCHEMA_PATH } from "../src/ops/OperationStore.js";

/**
 * Recording fake standing in for pg.Pool.
 *
 * The store is pure SQL construction over a driver, so the useful assertions
 * are about the statements it emits: that values arrive as bind parameters
 * rather than interpolated text, and that the clauses the design depends on
 * are actually present.
 */
interface Recorded { text: string; values: unknown[] }

class FakePool {
    readonly queries: Recorded[] = [];
    readonly clientQueries: Recorded[] = [];
    released = 0;
    /** Queued responses keyed by a substring of the SQL. */
    responses: Array<[match: string, rows: any[]]> = [];

    private respond(text: string): { rows: any[]; rowCount: number } {
        for (const [match, rows] of this.responses) {
            if (text.includes(match)) return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
    }

    query = async (text: string, values: unknown[] = []) => {
        this.queries.push({ text, values });
        return this.respond(text);
    };

    connect = async () => ({
        query: async (text: string, values: unknown[] = []) => {
            this.clientQueries.push({ text, values });
            return this.respond(text);
        },
        release: () => { this.released++; },
    });

    /** All SQL seen, pool-level and client-level. */
    get allSql(): string[] {
        return [...this.queries, ...this.clientQueries].map(q => q.text);
    }

    find(match: string): Recorded | undefined {
        return [...this.queries, ...this.clientQueries].find(q => q.text.includes(match));
    }

    asPool(): Pool { return this as unknown as Pool; }
}

let pool: FakePool;
let store: OperationStore;

beforeEach(() => {
    pool = new FakePool();
    store = new OperationStore(pool.asPool());
});

const ENQUEUE = {
    instanceId: "ad-prod",
    objectClass: "__ACCOUNT__",
    opType: "CREATE" as const,
    laneKey: "create:__ACCOUNT__:jdoe",
    idempotencyKey: "req-1",
    nameAttrValue: "jdoe",
    attrs: { __NAME__: "jdoe" },
};

/** Operation ids are uuids; the store rejects anything that cannot be one. */
const OP_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const ABSENT_ID = "0b5f8f2e-1c3a-4d5e-8f70-9a1b2c3d4e5f";

describe("schema.sql", () => {
    let sql: string;

    beforeEach(async () => {
        sql = await readFile(OPERATIONS_SCHEMA_PATH, "utf8");
    });

    it("range-partitions the hot table on created_at", () => {
        expect(sql).toMatch(/PARTITION BY RANGE \(created_at\)/);
    });

    it("includes the partition key in the primary key", () => {
        // Postgres refuses a unique or primary key on a partitioned table that
        // omits the partition column, so `id` alone cannot be the key.
        expect(sql).toMatch(/PRIMARY KEY \(id, created_at\)/);
    });

    it("constrains op_type, priority, and the full status taxonomy", () => {
        expect(sql).toMatch(/op_type IN \('CREATE', 'UPDATE', 'DELETE', 'ADD_VALUES', 'REMOVE_VALUES'\)/);
        expect(sql).toMatch(/priority IN \('interactive', 'batch'\)/);
        for (const status of [
            "PENDING", "RUNNING", "AWAITING_READBACK", "SUCCEEDED",
            "REJECTED_PRE_DISPATCH", "FAILED_CONFIRMED", "INDETERMINATE",
        ]) {
            expect(sql, status).toContain(`'${status}'`);
        }
    });

    it("indexes the claimable set and the lanes off one derived predicate", () => {
        // Both are predicated on the generated terminal column rather than a
        // hand-written status list, so adding a status cannot silently miss one.
        expect(sql).toMatch(/operations_claimable_idx[\s\S]*?\(instance_id, status, not_before\)[\s\S]*?WHERE NOT terminal/);
        expect(sql).toMatch(/operations_lane_idx[\s\S]*?\(instance_id, lane_key\)[\s\S]*?WHERE NOT terminal/);
    });

    it("derives terminality instead of enumerating it", () => {
        expect(sql).toMatch(/terminal\s+boolean[\s\S]*?GENERATED ALWAYS AS \([\s\S]*?status NOT IN \('PENDING', 'RUNNING', 'AWAITING_READBACK'\)[\s\S]*?\) STORED/);
    });

    it("keeps history slim and unpartitioned, with uid retained", () => {
        const history = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS operations_history"));
        const body = history.slice(0, history.indexOf(");"));
        expect(body).toContain("uid");
        // The payload columns must not survive into the permanent record.
        expect(body).not.toContain("attrs");
        expect(body).not.toContain("result");
        expect(body).not.toContain("PARTITION BY");
    });

    it("gates partition drop on zero non-terminal rows", () => {
        const fn = sql.slice(sql.indexOf("FUNCTION drop_operations_partition"));
        // Counts via the derived column, so a new non-terminal status is
        // covered automatically rather than by remembering this site.
        expect(fn).toContain("WHERE NOT terminal");
        expect(fn).toMatch(/IF live_rows > 0 THEN[\s\S]*?RETURN false/);
    });
});

describe("enqueue", () => {
    it("serializes on an advisory lock inside a transaction", async () => {
        pool.responses = [["RETURNING id", [{ id: "op-1" }]]];
        await store.enqueue(ENQUEUE);

        const sql = pool.clientQueries.map(q => q.text);
        expect(sql[0]).toBe("BEGIN");
        expect(sql[1]).toContain("pg_advisory_xact_lock($1::bigint)");
        expect(sql.at(-1)).toBe("COMMIT");
    });

    it("derives a stable, deterministic lock key from the idempotency key", async () => {
        pool.responses = [["RETURNING id", [{ id: "op-1" }]]];
        await store.enqueue(ENQUEUE);
        const first = pool.find("pg_advisory_xact_lock")!.values[0];

        pool = new FakePool();
        pool.responses = [["RETURNING id", [{ id: "op-2" }]]];
        store = new OperationStore(pool.asPool());
        await store.enqueue(ENQUEUE);
        const second = pool.find("pg_advisory_xact_lock")!.values[0];

        expect(first).toBe(second);
        expect(String(first)).toMatch(/^-?\d+$/);
    });

    it("passes every value as a bind parameter", async () => {
        pool.responses = [["RETURNING id", [{ id: "op-1" }]]];
        await store.enqueue(ENQUEUE);

        const insert = pool.find("INSERT INTO operations")!;
        expect(insert.text).not.toContain("ad-prod");
        expect(insert.text).not.toContain("jdoe");
        expect(insert.values).toEqual([
            "ad-prod",
            "__ACCOUNT__",
            "CREATE",
            "batch",
            "create:__ACCOUNT__:jdoe",
            null,
            "jdoe",
            JSON.stringify({ __NAME__: "jdoe" }),
            "req-1",
        ]);
    });

    it("defaults priority to batch and carries interactive through when given", async () => {
        pool.responses = [["RETURNING id", [{ id: "op-1" }]]];
        await store.enqueue({ ...ENQUEUE, priority: "interactive" });
        expect(pool.find("INSERT INTO operations")!.values[3]).toBe("interactive");
    });

    it("returns the existing id without inserting when the key is already present", async () => {
        pool.responses = [["SELECT id FROM operations", [{ id: "op-existing" }]]];

        const res = await store.enqueue(ENQUEUE);

        expect(res).toEqual({ id: "op-existing", deduplicated: true });
        expect(pool.find("INSERT INTO operations")).toBeUndefined();
        expect(pool.clientQueries.at(-1)!.text).toBe("COMMIT");
    });

    it("rolls back and releases the client when the insert fails", async () => {
        const failing = new FakePool();
        failing.connect = async () => ({
            query: async (text: string, values: unknown[] = []) => {
                failing.clientQueries.push({ text, values });
                if (text.includes("INSERT INTO operations")) throw new Error("boom");
                return { rows: [], rowCount: 0 };
            },
            release: () => { failing.released++; },
        });

        await expect(new OperationStore(failing.asPool()).enqueue(ENQUEUE)).rejects.toThrow("boom");
        expect(failing.clientQueries.map(q => q.text)).toContain("ROLLBACK");
        expect(failing.released).toBe(1);
    });
});

describe("claimBatch", () => {
    const avail = new Map([
        ["ad-prod", { batchFree: 3, totalFree: 3 }],
        ["ldap", { batchFree: 2, totalFree: 2 }],
    ]);

    it("uses FOR UPDATE SKIP LOCKED and marks rows RUNNING", async () => {
        await store.claimBatch(50, [], avail);
        const q = pool.find("UPDATE operations")!;
        expect(q.text).toContain("FOR UPDATE OF o SKIP LOCKED");
        expect(q.text).toContain("SET status = 'RUNNING'");
        expect(q.text).toContain("claimed_at = now()");
    });

    it("orders interactive ahead of batch, then oldest first", async () => {
        await store.claimBatch(50, [], avail);
        const text = pool.find("UPDATE operations")!.text;
        expect(text).toContain("ORDER BY (priority = 'interactive') DESC, created_at");
    });

    it("caps rows per instance before the update, not after", async () => {
        // A row marked RUNNING and then discarded by the caller would be
        // stranded non-terminal, so the cap has to bind inside the statement.
        const text = pool.find("UPDATE operations")?.text
            ?? (await store.claimBatch(50, [], avail), pool.find("UPDATE operations")!.text);
        expect(text).toContain("row_number() OVER");
        expect(text).toContain("PARTITION BY o.instance_id");
        expect(text).toContain("WHERE rn <= cap");
    });

    it("binds instance ids, both caps, lanes, and limit as parameters", async () => {
        const sliced = new Map([
            ["ad-prod", { batchFree: 1, totalFree: 3 }],
            ["ldap", { batchFree: 2, totalFree: 2 }],
        ]);
        await store.claimBatch(50, ["uid:__ACCOUNT__:abc"], sliced);
        const q = pool.find("UPDATE operations")!;
        expect(q.values).toEqual([
            ["ad-prod", "ldap"],
            [3, 2],
            [1, 2],
            ["uid:__ACCOUNT__:abc"],
            50,
        ]);
        expect(q.text).not.toContain("ad-prod");
    });

    it("clamps the batch cap to the total, never above it", async () => {
        // batchFree above totalFree would let a cap that is meant to restrict
        // batch work read as permission to exceed the instance budget.
        await store.claimBatch(50, [], new Map([["ad-prod", { batchFree: 99, totalFree: 4 }]]));
        expect(pool.find("UPDATE operations")!.values[2]).toEqual([4]);
    });

    it("caps batch rows by their own rank, leaving interactive on the total", async () => {
        await store.claimBatch(50, [], avail);
        const text = pool.find("UPDATE operations")!.text;
        expect(text).toContain("PARTITION BY instance_id, priority");
        expect(text).toContain("AS class_rn");
        expect(text).toContain("priority <> 'batch' OR class_rn <= batch_cap");
    });

    it("excludes active lanes", async () => {
        await store.claimBatch(50, ["lane-a"], avail);
        expect(pool.find("UPDATE operations")!.text).toContain("NOT (o.lane_key = ANY($4::text[]))");
    });

    it("collapses each lane to one row before applying the per-instance cap", async () => {
        // Two PENDING rows on one lane must not both enter a cycle, and
        // collapsing has to happen before ranking -- otherwise a same-lane
        // backlog consumes the cap with rows that are then discarded.
        await store.claimBatch(50, [], avail);
        const text = pool.find("UPDATE operations")!.text;

        expect(text).toContain("PARTITION BY o.instance_id, o.lane_key");
        expect(text).toContain("WHERE lane_rn = 1");
        expect(text.indexOf("lane_leaders")).toBeLessThan(text.indexOf("ranked AS"));
    });

    it("drops instances with no available slots", async () => {
        await store.claimBatch(50, [], new Map([
            ["ad-prod", { batchFree: 0, totalFree: 0 }],
            ["ldap", { batchFree: 4, totalFree: 4 }],
        ]));
        expect(pool.find("UPDATE operations")!.values[0]).toEqual(["ldap"]);
    });

    it("skips the query entirely when nothing can be claimed", async () => {
        expect(await store.claimBatch(50, [], new Map([["ad-prod", { batchFree: 0, totalFree: 0 }]]))).toEqual([]);
        expect(await store.claimBatch(0, [], avail)).toEqual([]);
        expect(pool.queries).toHaveLength(0);
    });

    it("maps claimed rows into camelCase operations", async () => {
        pool.responses = [["UPDATE operations", [{
            id: "op-1", instance_id: "ad-prod", object_class: "__ACCOUNT__", op_type: "UPDATE",
            priority: "interactive", lane_key: "uid:__ACCOUNT__:u1", uid: "u1",
            name_attr_value: null, attrs: { title: "x" }, attempt_count: 2,
            created_at: new Date("2026-08-01T00:00:00Z"), idempotency_key: "req-9",
        }]]];

        const [op] = await store.claimBatch(10, [], avail);
        expect(op).toMatchObject({
            id: "op-1", instanceId: "ad-prod", objectClass: "__ACCOUNT__", opType: "UPDATE",
            priority: "interactive", laneKey: "uid:__ACCOUNT__:u1", uid: "u1",
            nameAttrValue: null, attemptCount: 2, idempotencyKey: "req-9",
        });
    });

    it("does not increment attempt_count on claim", async () => {
        // attempt_count counts requeues, so a first attempt runs at 0. The
        // claim still has to return the column for the dispatcher's retry cap,
        // so only the SET clause is off limits.
        await store.claimBatch(50, [], avail);
        const text = pool.find("UPDATE operations")!.text;
        const setClause = text.slice(text.indexOf("SET status = 'RUNNING'"), text.indexOf("FROM locked"));
        expect(setClause).not.toContain("attempt_count");
        expect(text).toContain("RETURNING");
        expect(text).toContain("o.attempt_count");
    });
});

describe("finalize", () => {
    const terminalRow = {
        id: "op-1", instance_id: "ad-prod", object_class: "__ACCOUNT__", op_type: "CREATE",
        status: "SUCCEEDED", uid: null, error_code: null,
        created_at: new Date("2026-08-01T00:00:00Z"), finalized_at: new Date("2026-08-01T00:00:03Z"),
        result: { uid: "minted-123" },
    };

    it("writes the terminal status and the history row in one transaction", async () => {
        pool.responses = [["UPDATE operations", [terminalRow]]];
        expect(await store.finalize(OP_ID, "SUCCEEDED", { uid: "minted-123" })).toBe(true);

        const sql = pool.clientQueries.map(q => q.text);
        expect(sql[0]).toBe("BEGIN");
        expect(sql.some(s => s.includes("INSERT INTO operations_history"))).toBe(true);
        expect(sql.at(-1)).toBe("COMMIT");
    });

    it("refuses to overwrite an already-terminal row", async () => {
        const q = (pool.responses = [["UPDATE operations", [terminalRow]]],
            await store.finalize(OP_ID, "SUCCEEDED"), pool.find("UPDATE operations")!);
        expect(q.text).toContain("NOT (status = ANY($5::text[]))");
        expect(q.values[4]).toEqual([
            "SUCCEEDED", "REJECTED_PRE_DISPATCH", "FAILED_CONFIRMED", "INDETERMINATE",
        ]);
    });

    it("returns false and rolls back when nothing was updated", async () => {
        expect(await store.finalize(ABSENT_ID, "FAILED_CONFIRMED")).toBe(false);
        expect(pool.clientQueries.map(q => q.text)).toContain("ROLLBACK");
        expect(pool.clientQueries.some(q => q.text.includes("operations_history"))).toBe(false);
    });

    it("prefers the create result's minted uid for the history row", async () => {
        pool.responses = [["UPDATE operations", [terminalRow]]];
        await store.finalize(OP_ID, "SUCCEEDED", { uid: "minted-123" });

        const hist = pool.find("INSERT INTO operations_history")!;
        expect(hist.text).toContain("COALESCE($6, ($7::jsonb)->>'uid')");
        expect(hist.values[5]).toBeNull();                                  // no request uid on a create
        expect(hist.values[6]).toBe(JSON.stringify({ uid: "minted-123" })); // result carries it
    });

    it("binds the error code rather than interpolating it", async () => {
        pool.responses = [["UPDATE operations", [terminalRow]]];
        await store.finalize(OP_ID, "FAILED_CONFIRMED", undefined, "ALREADY_EXISTS");
        const q = pool.find("UPDATE operations")!;
        expect(q.values[3]).toBe("ALREADY_EXISTS");
        expect(q.text).not.toContain("ALREADY_EXISTS");
    });
});

describe("requeue", () => {
    it("returns a RUNNING row to PENDING and counts the retry", async () => {
        pool.responses = [["UPDATE operations", [{}]]];
        expect(await store.requeue(OP_ID)).toBe(true);

        const q = pool.find("UPDATE operations")!;
        expect(q.text).toContain("SET status = 'PENDING'");
        expect(q.text).toContain("claimed_at = NULL");
        expect(q.text).toContain("attempt_count = attempt_count + 1");
        expect(q.text).toContain("status = 'RUNNING'");
        expect(q.values).toEqual([OP_ID]);
    });

    it("reports false when the row was not RUNNING", async () => {
        expect(await store.requeue(OP_ID)).toBe(false);
    });
});

describe("pendingCounts", () => {
    it("splits the backlog by priority class", async () => {
        pool.responses = [["GROUP BY priority", [
            { priority: "interactive", n: 4 },
            { priority: "batch", n: 900 },
        ]]];
        expect(await store.pendingCounts("ad-prod")).toEqual({ interactive: 4, batch: 900 });
    });

    it("reports zeroes for an empty backlog", async () => {
        expect(await store.pendingCounts("ad-prod")).toEqual({ interactive: 0, batch: 0 });
        expect(pool.queries[0]!.values).toEqual(["ad-prod"]);
        expect(pool.queries[0]!.text).toContain("status IN ('PENDING', 'AWAITING_READBACK')");
    });
});

describe("getStatus", () => {
    it("returns the hot row when it is still there", async () => {
        pool.responses = [["FROM operations\n", [{
            id: "op-1", instance_id: "ad-prod", object_class: "__ACCOUNT__", op_type: "CREATE",
            status: "RUNNING", attempt_count: 1, result: null, error_code: null,
            created_at: new Date("2026-08-01T00:00:00Z"), finalized_at: null,
        }]]];

        const row = await store.getStatus(OP_ID);
        expect(row).toMatchObject({ id: "op-1", status: "RUNNING", attemptCount: 1, fromHistory: false });
        expect(pool.queries).toHaveLength(1);
    });

    it("falls back to history once the hot row has aged out", async () => {
        // A caller polling past the 24h window should still get an outcome
        // rather than a 404.
        pool.responses = [["operations_history", [{
            id: "op-1", instance_id: "ad-prod", object_class: "__ACCOUNT__", op_type: "CREATE",
            status: "SUCCEEDED", uid: "minted-123", error_code: null,
            created_at: new Date("2026-07-30T00:00:00Z"), finalized_at: new Date("2026-07-30T00:00:02Z"),
        }]]];

        const row = await store.getStatus(OP_ID);
        expect(row).toMatchObject({ status: "SUCCEEDED", fromHistory: true });
        expect(row!.result).toEqual({ uid: "minted-123" });
    });

    it("returns null when neither table has the id", async () => {
        expect(await store.getStatus(ABSENT_ID)).toBeNull();
        expect(pool.queries).toHaveLength(2);
    });
});

describe("malformed operation ids", () => {
    // Operation ids arrive straight from a URL path. Postgres answers a
    // malformed uuid with a type error, so without this guard a mistyped id
    // becomes a 500 instead of a 404.
    it("treats a non-uuid as simply absent, without querying", async () => {
        expect(await store.getStatus("not-a-uuid")).toBeNull();
        expect(await store.finalize("../../etc/passwd", "SUCCEEDED")).toBe(false);
        expect(await store.requeue("'; DROP TABLE operations; --")).toBe(false);

        expect(pool.queries).toHaveLength(0);
        expect(pool.clientQueries).toHaveLength(0);
    });
});
