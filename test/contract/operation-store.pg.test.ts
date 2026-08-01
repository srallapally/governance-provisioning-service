import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OperationStore } from "../../src/ops/OperationStore.js";
import { runOperationStoreContract } from "./operation-store.contract.js";
import {
  applySchema,
  openPool,
  probePostgres,
  resetOperations,
  type PgPool,
} from "../harness/pg.js";
import { describeWithPg } from "../harness/describeWithPg.js";

// Top-level await: the probe has to finish before suites are registered, which
// is what lets an unreachable server skip rather than fail.
const probe = await probePostgres();

describeWithPg(probe, "OperationStore against Postgres", () => {
  let pool: PgPool;

  beforeAll(async () => {
    pool = openPool(probe.url!);
    await applySchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await resetOperations(pool);
  });

  runOperationStoreContract("OperationStore (postgres)", () => ({
    store: new OperationStore(pool),
    expireHotRow: async (id: string) => {
      await pool.query("DELETE FROM operations WHERE id = $1", [id]);
    },
  }));

  it("never hands the same row to two concurrent claimers", async () => {
    // The claim protocol's core guarantee. Replicas coordinate through
    // SKIP LOCKED alone, so if this breaks, two dispatchers run the same
    // mutation against the target at the same time.
    const store = new OperationStore(pool);
    const lanes = 40;
    for (let i = 0; i < lanes; i++) {
      await store.enqueue({
        instanceId: "ad-prod",
        objectClass: "__ACCOUNT__",
        opType: "CREATE",
        laneKey: `lane-${i}`,
        idempotencyKey: `race-${i}`,
        nameAttrValue: `user${i}`,
      });
    }

    const avail = new Map([["ad-prod", lanes]]);
    const [a, b, c] = await Promise.all([
      store.claimBatch(lanes, [], avail),
      store.claimBatch(lanes, [], avail),
      store.claimBatch(lanes, [], avail),
    ]);

    const ids = [...a, ...b, ...c].map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);   // no row claimed twice
    expect(ids).toHaveLength(lanes);              // and none lost

    const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM operations WHERE status = 'RUNNING'",
    );
    expect(rows[0].n).toBe(lanes);
  });

  it("keeps idempotent enqueue single-rowed under concurrency", async () => {
    // The advisory lock is doing the work here: the unique index cannot,
    // because it must include created_at to exist on a partitioned table.
    const store = new OperationStore(pool);
    const results = await Promise.all(
        Array.from({ length: 8 }, () => store.enqueue({
          instanceId: "ad-prod",
          objectClass: "__ACCOUNT__",
          opType: "CREATE",
          laneKey: "create:__ACCOUNT__:solo",
          idempotencyKey: "one-and-only",
          nameAttrValue: "solo",
        })),
    );

    const ids = new Set(results.map(r => r.id));
    expect(ids.size).toBe(1);

    const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM operations WHERE idempotency_key = $1",
        ["one-and-only"],
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses to drop a partition holding a deferred read-back", async () => {
    // The failure this guards against is silent and destroys data: had the
    // gate kept a hand-written status allow-list, a new non-terminal status
    // would not have appeared in it, the partition would have counted as fully
    // terminal, and an answer a caller was promised would have been dropped.
    const store = new OperationStore(pool);
    const { id } = await store.enqueue({
      instanceId: "ad-prod",
      objectClass: "__ACCOUNT__",
      opType: "CREATE",
      laneKey: "create:__ACCOUNT__:gate",
      idempotencyKey: "gate-1",
      nameAttrValue: "gate",
    });
    await store.claimBatch(10, [], new Map([["ad-prod", 5]]));
    await store.deferForReadback(id, new Date(Date.now() + 3_600_000));

    const refused = await pool.query("SELECT drop_operations_partition(current_date) AS dropped");
    expect(refused.rows[0].dropped).toBe(false);

    await pool.query("UPDATE operations SET status='SUCCEEDED', finalized_at=now() WHERE id=$1", [id]);
    const dropped = await pool.query("SELECT drop_operations_partition(current_date) AS dropped");
    expect(dropped.rows[0].dropped).toBe(true);

    // Re-create it so later tests in this file still have somewhere to insert.
    await pool.query("SELECT create_operations_partition(current_date)");
  });

  it("derives terminality rather than trusting the caller", async () => {
    const store = new OperationStore(pool);
    const { id } = await store.enqueue({
      instanceId: "ad-prod",
      objectClass: "__ACCOUNT__",
      opType: "CREATE",
      laneKey: "create:__ACCOUNT__:derive",
      idempotencyKey: "derive-1",
      nameAttrValue: "derive",
    });

    const seen: Array<[string, boolean]> = [];
    const read = async () => {
      const r = await pool.query("SELECT status, terminal FROM operations WHERE id=$1", [id]);
      seen.push([r.rows[0].status, r.rows[0].terminal]);
    };

    await read();                                                   // PENDING
    await store.claimBatch(10, [], new Map([["ad-prod", 5]]));
    await read();                                                   // RUNNING
    await store.deferForReadback(id, new Date(Date.now() + 60_000));
    await read();                                                   // AWAITING_READBACK
    await pool.query("UPDATE operations SET status='SUCCEEDED' WHERE id=$1", [id]);
    await read();                                                   // SUCCEEDED

    expect(seen).toEqual([
      ["PENDING", false],
      ["RUNNING", false],
      ["AWAITING_READBACK", false],
      ["SUCCEEDED", true],
    ]);
  });

  it("serializes concurrent reapers so one pass does the work", async () => {
    const store = new OperationStore(pool);
    for (let i = 0; i < 6; i++) {
      await store.enqueue({
        instanceId: "ad-prod",
        objectClass: "__ACCOUNT__",
        opType: "DELETE",
        laneKey: `uid:__ACCOUNT__:r${i}`,
        idempotencyKey: `reap-${i}`,
        uid: `r${i}`,
      });
    }
    await store.claimBatch(10, [], new Map([["ad-prod", 10]]));

    // Three replicas reaping at once; the advisory lock means the losers do
    // nothing rather than double-reaping.
    const passes = await Promise.all([
      store.reapStale(0, 60_000),
      store.reapStale(0, 60_000),
      store.reapStale(0, 60_000),
    ]);

    const total = passes.reduce((n, p) => n + p.requeued, 0);
    expect(total).toBe(6);

    const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM operations WHERE status='PENDING' AND attempt_count=0");
    expect(rows[0].n).toBe(6);
  });
});