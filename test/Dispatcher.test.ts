import { describe, it, expect, afterEach, vi } from "vitest";
import { ConnectorRegistry } from "@governance-connector-framework/core";
import { ConnectorManager } from "@governance-connector-framework/core";
import { Dispatcher } from "../src/ops/Dispatcher.js";
import {
    admitAndEnqueue,
    laneKeyFor,
    AdmissionRejectedError,
    isAdmissionRejected,
} from "../src/ops/admission.js";
import { MemoryOperationStore } from "./harness/MemoryOperationStore.js";
import { makeFakeConnector, type FakeConnector } from "@governance-connector-framework/core/testing";
import type { RuntimeConfigInput } from "@governance-connector-framework/core";
import type { EnqueueInput } from "../src/ops/OperationStore.js";

const OC = "__ACCOUNT__";

let store: MemoryOperationStore;
let registry: ConnectorRegistry;
let manager: ConnectorManager;
let dispatcher: Dispatcher;
let connector: FakeConnector;

interface SetupOpts {
    runtime?: RuntimeConfigInput;
    capabilities?: { idempotentDelta?: boolean; equalitySearchOnName?: boolean };
    connectorOpts?: Parameters<typeof makeFakeConnector>[0];
    instanceId?: string;
    dispatcherConfig?: Record<string, unknown>;
}

function setup(opts: SetupOpts = {}): void {
    const instanceId = opts.instanceId ?? "ad-prod";
    store = new MemoryOperationStore();
    registry = new ConnectorRegistry();
    connector = makeFakeConnector(opts.connectorOpts ?? {});

    registry.registerFactory("fake", "1.0.0", async () => connector);
    registry.registerCapabilities("fake", "1.0.0", {
        equalitySearchOnName: true,
        ...opts.capabilities,
    });
    registry.registerInstance(instanceId, "fake", "1.0.0", {}, opts.runtime ?? {});

    manager = new ConnectorManager(registry, { logger: { error: () => {} } });
    dispatcher = new Dispatcher({
        store,
        manager,
        registry,
        config: {
            backoffBaseMs: 10,
            backoffMaxMs: 20,
            readBackGraceMs: 5,
            logger: { error: () => {} },
            ...(opts.dispatcherConfig ?? {}),
        },
    });
}

afterEach(async () => {
    await dispatcher?.stop();
    vi.useRealTimers();
});

function enqueue(overrides: Partial<EnqueueInput> & { idempotencyKey: string }) {
    const base = {
        instanceId: "ad-prod",
        objectClass: OC,
        opType: "CREATE" as const,
        ...overrides,
    };
    return store.enqueue({
        ...base,
        laneKey: base.laneKey ?? laneKeyFor(base.opType, base.objectClass, base),
    } as EnqueueInput);
}

/**
 * Run cycles until every operation reaches a terminal state.
 *
 * Real time has to pass between cycles: deadlines, backoff windows, and the
 * read-back delay are all setTimeout-based, so draining microtasks alone would
 * declare the queue finished while work is still scheduled.
 */
async function drain(timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        await dispatcher.runCycle();
        await new Promise(r => setTimeout(r, 2));

        const open = store.allRows().some(r =>
            r.status === "PENDING" || r.status === "RUNNING" || r.status === "AWAITING_READBACK");
        if (!open && dispatcher.inFlightCount === 0) return;
    }
    throw new Error(
        `drain timed out after ${timeoutMs}ms; ` +
        `statuses: ${store.allRows().map(r => `${r.id}=${r.status}`).join(", ")}`,
    );
}

describe("lane keys", () => {
    it("keys a create on the naming attribute and a mutation on the uid", () => {
        expect(laneKeyFor("CREATE", OC, { nameAttrValue: "jdoe" })).toBe("create:__ACCOUNT__:jdoe");
        expect(laneKeyFor("UPDATE", OC, { uid: "u1" })).toBe("uid:__ACCOUNT__:u1");
        expect(laneKeyFor("DELETE", OC, { uid: "u1" })).toBe("uid:__ACCOUNT__:u1");
    });

    it("namespaces the two forms so they cannot collide", () => {
        expect(laneKeyFor("CREATE", OC, { nameAttrValue: "x" }))
            .not.toBe(laneKeyFor("DELETE", OC, { uid: "x" }));
    });

    it("refuses to build a key without the identity it needs", () => {
        expect(() => laneKeyFor("CREATE", OC, {})).toThrow(/naming attribute/);
        expect(() => laneKeyFor("UPDATE", OC, {})).toThrow(/uid/);
    });
});

describe("CREATE resolution", () => {
    it("succeeds and persists the target-minted uid", async () => {
        setup();
        const { id } = await enqueue({ idempotencyKey: "c1", nameAttrValue: "jdoe", attrs: { __NAME__: "jdoe" } });

        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect((row!.result as any).uid).toMatch(/^uid-\d+$/);
        expect((row!.result as any).object.attributes.__NAME__).toBe("jdoe");
    });

    it("records ALREADY_EXISTS as a confirmed failure", async () => {
        setup();
        await connector.create!(OC, { __NAME__: "taken" });

        const { id } = await enqueue({ idempotencyKey: "c2", nameAttrValue: "taken", attrs: { __NAME__: "taken" } });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("FAILED_CONFIRMED");
        expect(row!.errorCode).toBe("ALREADY_EXISTS");
    });

    it("recovers a timed-out create by reading back the object it made", async () => {
        // The INDETERMINATE case CP-1 designed read-back for: the target
        // applied the create, the answer never arrived, and retrying blind
        // would produce a duplicate account.
        setup({ runtime: { attemptDeadlineMs: 20 } });
        connector.controls.applyThenHang();

        const { id } = await enqueue({ idempotencyKey: "c3", nameAttrValue: "ghost", attrs: { __NAME__: "ghost" } });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect((row!.result as any).viaReadBack).toBe(true);
        expect((row!.result as any).uid).toBeDefined();
        // Exactly one account, not two.
        expect(connector.controls.target.size).toBe(1);
    });

    it("retries once when read-back confirms the create never landed", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 } });
        connector.controls.hangUntilAborted();   // nothing applied

        const { id } = await enqueue({ idempotencyKey: "c4", nameAttrValue: "retry", attrs: { __NAME__: "retry" } });
        await drain();

        const row = await store.getStatus(id);
        // First attempt timed out and read-back missed, so one retry ran and
        // succeeded on a healthy connector.
        expect(row!.status).toBe("SUCCEEDED");
        expect(connector.controls.countOf("create")).toBe(2);
    });

    it("records INDETERMINATE immediately when the connector cannot search by name", async () => {
        setup({
            runtime: { attemptDeadlineMs: 20 },
            capabilities: { equalitySearchOnName: false },
            connectorOpts: { equalitySearchOnName: false },
        });
        connector.controls.applyThenHang();

        const { id } = await enqueue({ idempotencyKey: "c5", nameAttrValue: "lost", attrs: { __NAME__: "lost" } });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("INDETERMINATE");
        expect(row!.errorCode).toBe("DEADLINE_NO_READBACK");
        // No read-back was attempted; reconciliation is the backstop.
        expect(connector.controls.countOf("search")).toBe(0);
    });
});

describe("DELETE resolution", () => {
    it("treats UNKNOWN_UID as success, because the object is absent", async () => {
        setup();
        const { id } = await enqueue({
            idempotencyKey: "d1", opType: "DELETE", uid: "never-existed",
        });

        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect((row!.result as any).alreadyAbsent).toBe(true);
    });

    it("deletes an existing object", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "doomed" });
        const { id } = await enqueue({ idempotencyKey: "d2", opType: "DELETE", uid: created.uid });

        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        expect(connector.controls.target.size).toBe(0);
    });

    it("retries a retryable failure and then succeeds", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "flaky" });
        connector.controls.failNext("CONNECTION_FAILED");

        const { id } = await enqueue({ idempotencyKey: "d3", opType: "DELETE", uid: created.uid });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect(row!.attemptCount).toBeGreaterThanOrEqual(1);
    });

    it("stops retrying at the attempt cap", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "hopeless" });
        // Re-arm on every call so it never succeeds.
        const origDelete = connector.delete!.bind(connector);
        (connector as any).delete = async (...args: any[]) => {
            connector.controls.failNext("CONNECTION_FAILED");
            return origDelete(...(args as [any, any, any]));
        };

        const { id } = await enqueue({ idempotencyKey: "d4", opType: "DELETE", uid: created.uid });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("INDETERMINATE");
        expect(row!.attemptCount).toBe(4);   // maxAttempts 5 => 4 requeues
    });

    it("records a non-retryable failure as confirmed", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "denied" });
        connector.controls.failNext("PERMISSION_DENIED");

        const { id } = await enqueue({ idempotencyKey: "d5", opType: "DELETE", uid: created.uid });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("FAILED_CONFIRMED");
        expect(row!.errorCode).toBe("PERMISSION_DENIED");
    });
});

describe("UPDATE resolution and the delta retry gate", () => {
    it("retries a replace update after a deadline", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 } });
        const created = await connector.create!(OC, { __NAME__: "u" });
        connector.controls.hangUntilAborted();

        const { id } = await enqueue({
            idempotencyKey: "u1", opType: "UPDATE", uid: created.uid, attrs: { title: "staff" },
        });
        await drain();

        // Replace semantics are idempotent by construction, so the retry is safe.
        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect(connector.controls.countOf("update")).toBe(2);
    });

    it("retries a replace update on deadline regardless of the delta flag", async () => {
        // UPDATE is always a full replace now, which is idempotent by
        // construction. Deltas are their own op types with their own gate.
        setup({ runtime: { attemptDeadlineMs: 20 }, capabilities: { idempotentDelta: false } });
        const created = await connector.create!(OC, { __NAME__: "u" });
        connector.controls.hangUntilAborted();

        const { id } = await enqueue({
            idempotencyKey: "u2", opType: "UPDATE", uid: created.uid, attrs: { title: "x" },
        });
        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        expect(connector.controls.countOf("update")).toBe(2);
    });

    it("records UNKNOWN_UID on update as a confirmed failure", async () => {
        // Unlike delete, an update of a missing object cannot reach its
        // desired end state.
        setup();
        const { id } = await enqueue({
            idempotencyKey: "u4", opType: "UPDATE", uid: "ghost", attrs: { title: "x" },
        });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("FAILED_CONFIRMED");
        expect(row!.errorCode).toBe("UNKNOWN_UID");
    });
});

describe("lane serialization", () => {
    it("never runs two operations on one lane concurrently", async () => {
        setup({ runtime: { mutationConcurrency: 10 } });
        const created = await connector.create!(OC, { __NAME__: "hot" });

        let concurrent = 0;
        let maxConcurrent = 0;
        const origUpdate = connector.update!.bind(connector);
        (connector as any).update = async (...args: any[]) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            try { return await origUpdate(...(args as [any, any, any, any])); }
            finally { concurrent--; }
        };

        for (let i = 0; i < 5; i++) {
            await enqueue({
                idempotencyKey: `lane-${i}`, opType: "UPDATE", uid: created.uid,
                attrs: { title: `t${i}` },
            });
        }
        await drain();

        expect(maxConcurrent).toBe(1);
        expect(connector.controls.countOf("update")).toBe(5);
    });

    it("runs different lanes in parallel", async () => {
        setup({ runtime: { mutationConcurrency: 10 } });

        let concurrent = 0;
        let maxConcurrent = 0;
        const origCreate = connector.create!.bind(connector);
        (connector as any).create = async (...args: any[]) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            try {
                await new Promise(r => setTimeout(r, 5));
                return await origCreate(...(args as [any, any, any]));
            } finally { concurrent--; }
        };

        for (let i = 0; i < 5; i++) {
            await enqueue({
                idempotencyKey: `par-${i}`, nameAttrValue: `user${i}`, attrs: { __NAME__: `user${i}` },
            });
        }
        await drain();

        expect(maxConcurrent).toBeGreaterThan(1);
    });
});

describe("priority", () => {
    it("dispatches interactive work ahead of a batch backlog", async () => {
        setup({ runtime: { mutationConcurrency: 1 } });

        for (let i = 0; i < 10; i++) {
            await enqueue({
                idempotencyKey: `b-${i}`, nameAttrValue: `batch${i}`, attrs: { __NAME__: `batch${i}` },
            });
        }
        await enqueue({
            idempotencyKey: "urgent", nameAttrValue: "helpdesk",
            attrs: { __NAME__: "helpdesk" }, priority: "interactive",
        });

        await drain();

        const order = connector.controls.calls
            .filter(c => c.op === "create")
            .map(c => (c.args[1] as any).__NAME__);

        // Enqueued last, dispatched first.
        expect(order[0]).toBe("helpdesk");
    });
});

describe("concurrency budget", () => {
    it("holds in-flight mutations at the configured budget", async () => {
        setup({ runtime: { mutationConcurrency: 2 } });

        let concurrent = 0;
        let maxConcurrent = 0;
        const origCreate = connector.create!.bind(connector);
        (connector as any).create = async (...args: any[]) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            try {
                await new Promise(r => setTimeout(r, 5));
                return await origCreate(...(args as [any, any, any]));
            } finally { concurrent--; }
        };

        for (let i = 0; i < 8; i++) {
            await enqueue({
                idempotencyKey: `cap-${i}`, nameAttrValue: `u${i}`, attrs: { __NAME__: `u${i}` },
            });
        }
        await drain();

        expect(maxConcurrent).toBeLessThanOrEqual(2);
        expect(connector.controls.countOf("create")).toBe(8);
    });
});

describe("admission", () => {
    it("admits below the cap and rejects at it, reporting depth", async () => {
        setup();

        await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "a1", nameAttrValue: "one", attrs: { __NAME__: "one" },
        }, { batch: 2 });
        await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "a2", nameAttrValue: "two", attrs: { __NAME__: "two" },
        }, { batch: 2 });

        const err = await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "a3", nameAttrValue: "three", attrs: { __NAME__: "three" },
        }, { batch: 2 }).catch(e => e);

        expect(isAdmissionRejected(err)).toBe(true);
        expect((err as AdmissionRejectedError).backlogDepth).toBe(2);
        expect((err as AdmissionRejectedError).cap).toBe(2);
    });

    it("caps the two priority classes separately", async () => {
        setup();
        await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "p1", nameAttrValue: "b", attrs: { __NAME__: "b" },
        }, { batch: 1, interactive: 1 });

        // Batch is full; interactive still has room.
        await expect(admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "p2", nameAttrValue: "b2", attrs: { __NAME__: "b2" },
        }, { batch: 1, interactive: 1 })).rejects.toThrow(AdmissionRejectedError);

        await expect(admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "p3", nameAttrValue: "i", attrs: { __NAME__: "i" },
            priority: "interactive",
        }, { batch: 1, interactive: 1 })).resolves.toBeDefined();
    });

    it("derives the lane key when the caller does not supply one", async () => {
        setup();
        const { id } = await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "DELETE",
            idempotencyKey: "lk", uid: "u-9",
        });
        const row = store.allRows().find(r => r.id === id);
        expect(row!.laneKey).toBe("uid:__ACCOUNT__:u-9");
    });

    it("frees capacity as the backlog drains", async () => {
        setup();
        await admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "f1", nameAttrValue: "x", attrs: { __NAME__: "x" },
        }, { batch: 1 });

        await drain();

        await expect(admitAndEnqueue(store, {
            instanceId: "ad-prod", objectClass: OC, opType: "CREATE",
            idempotencyKey: "f2", nameAttrValue: "y", attrs: { __NAME__: "y" },
        }, { batch: 1 })).resolves.toBeDefined();
    });
});

describe("failure handling", () => {
    it("records REJECTED_PRE_DISPATCH when the connector cannot be built", async () => {
        store = new MemoryOperationStore();
        registry = new ConnectorRegistry();
        registry.registerFactory("broken", "1.0.0", async () => { throw new Error("no credentials"); });
        registry.registerInstance("ad-prod", "broken", "1.0.0", {});
        manager = new ConnectorManager(registry, { logger: { error: () => {} } });
        dispatcher = new Dispatcher({ store, manager, registry, config: { logger: { error: () => {} } } });

        const { id } = await enqueue({ idempotencyKey: "x1", nameAttrValue: "x", attrs: { __NAME__: "x" } });
        await drain();

        const row = await store.getStatus(id);
        // Nothing reached the target, so this is safe to retry wholesale.
        expect(row!.status).toBe("REJECTED_PRE_DISPATCH");
        expect(row!.errorCode).toBe("ACQUIRE_FAILED");
    });

    it("releases the lease after every attempt, including failures", async () => {
        setup();
        connector.controls.failNext("PERMISSION_DENIED");
        await enqueue({ idempotencyKey: "r1", nameAttrValue: "x", attrs: { __NAME__: "x" } });
        await drain();

        expect(manager.refcountOf("ad-prod")).toBe(0);
    });
});

describe("lifecycle", () => {
    it("stops claiming after stop() and waits for in-flight work", async () => {
        setup();
        await enqueue({ idempotencyKey: "s1", nameAttrValue: "x", attrs: { __NAME__: "x" } });

        await dispatcher.stop();
        const claimed = await dispatcher.runCycle();

        expect(claimed).toBe(0);
        expect(dispatcher.inFlightCount).toBe(0);
    });

    it("skips an overlapping cycle rather than double-claiming", async () => {
        setup();
        for (let i = 0; i < 3; i++) {
            await enqueue({ idempotencyKey: `o-${i}`, nameAttrValue: `u${i}`, attrs: { __NAME__: `u${i}` } });
        }

        const [a, b] = await Promise.all([dispatcher.runCycle(), dispatcher.runCycle()]);
        // The second observed a cycle already running and did nothing.
        expect(Math.min(a, b)).toBe(0);
        await drain();
    });

    it("stop({drainBudgetMs}) returns once the budget elapses, not once every attempt settles (P2)", async () => {
        // attemptDeadlineMs comfortably outlives the drain budget, so the
        // attempt is still genuinely running when stop() gives up waiting --
        // proving the wait is bounded rather than incidentally fast.
        setup({ runtime: { attemptDeadlineMs: 300 } });
        connector.controls.hangUntilAborted();

        await enqueue({ idempotencyKey: "d1", nameAttrValue: "slow", attrs: { __NAME__: "slow" } });
        const claimed = await dispatcher.runCycle();
        expect(claimed).toBe(1);
        expect(dispatcher.inFlightCount).toBe(1);

        const startedAt = Date.now();
        await dispatcher.stop({ drainBudgetMs: 50 });
        const elapsedMs = Date.now() - startedAt;

        // Bounded by the budget, not by the 300ms attempt deadline. Generous
        // upper bound to absorb real-time scheduling jitter without letting
        // an unbounded wait pass silently.
        expect(elapsedMs).toBeLessThan(250);
        // stop() only ever stops waiting; it never cancels anything (no
        // AbortSignal is ever handed to an attempt), so the attempt this
        // budget gave up on is still running in the background.
        expect(dispatcher.inFlightCount).toBe(1);

        // Let the facade's own deadline abort it for real, so the test does
        // not leave a dangling in-flight promise behind it.
        await new Promise((r) => setTimeout(r, 350));
        expect(dispatcher.inFlightCount).toBe(0);
    });

    it("stop() with no budget waits unboundedly, as every existing caller relies on", async () => {
        setup({ runtime: { attemptDeadlineMs: 40 } });
        connector.controls.hangUntilAborted();

        await enqueue({ idempotencyKey: "d2", nameAttrValue: "eventually", attrs: { __NAME__: "eventually" } });
        await dispatcher.runCycle();
        expect(dispatcher.inFlightCount).toBe(1);

        await dispatcher.stop();

        // No opts at all means the omitted-budget branch, which waits for
        // the real Promise.allSettled -- the attempt has genuinely finished
        // by the time stop() resolves, not merely been given up on.
        expect(dispatcher.inFlightCount).toBe(0);
    });
});

describe("read-back deferral (BUG-1)", () => {
    it("releases the mutation slot while the read-back wait runs", async () => {
        // The defect: the wait used to be an inline sleep holding the slot, so
        // a degraded target converted its own timeouts into reduced drain --
        // worst exactly when it was already worst.
        // A long read-back grace keeps the parked window open for the whole
        // assertion, so this measures behaviour rather than a race.
        setup({
            runtime: { attemptDeadlineMs: 20, mutationConcurrency: 1 },
            dispatcherConfig: { readBackGraceMs: 5_000 },
        });
        connector.controls.applyThenHang();

        await enqueue({ idempotencyKey: "slot-1", nameAttrValue: "held", attrs: { __NAME__: "held" } });
        await enqueue({ idempotencyKey: "slot-2", nameAttrValue: "other", attrs: { __NAME__: "other" } });

        // First cycle claims op 1 (budget of 1); it times out and defers.
        await dispatcher.runCycle();
        await new Promise(r => setTimeout(r, 80));

        const parked = store.allRows().find(r => r.status === "AWAITING_READBACK");
        expect(parked, "the timed-out create should be parked").toBeDefined();

        // The single slot is free again, so the unrelated op can run even
        // though the first one has not resolved.
        await dispatcher.runCycle();
        await new Promise(r => setTimeout(r, 40));
        expect(connector.controls.target.findByName("other")).toBeDefined();
    });

    it("keeps the lane blocked while the wait runs", async () => {
        setup({
            runtime: { attemptDeadlineMs: 20, mutationConcurrency: 4 },
            dispatcherConfig: { readBackGraceMs: 5_000 },
        });
        connector.controls.applyThenHang();

        // Same naming attribute, so the same lane.
        await enqueue({ idempotencyKey: "lane-1", nameAttrValue: "dup", attrs: { __NAME__: "dup" } });
        await dispatcher.runCycle();
        await new Promise(r => setTimeout(r, 80));

        await enqueue({ idempotencyKey: "lane-2", nameAttrValue: "dup", attrs: { __NAME__: "dup" } });

        // The second create must not run while the first one's outcome is
        // unknown, or the read-back would be racing a duplicate.
        const claimed = await dispatcher.runCycle();
        expect(claimed).toBe(0);
    });

    it("does not spend the retry budget on the wait", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 } });
        connector.controls.applyThenHang();

        const { id } = await enqueue({ idempotencyKey: "budget", nameAttrValue: "b", attrs: { __NAME__: "b" } });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        // Deferral is not an attempt; counting it would have consumed the one
        // retry the read-back path allows before the read-back ever ran.
        expect(row!.attemptCount).toBe(0);
    });

    it("resumes by searching, never by re-issuing the create", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 } });
        connector.controls.applyThenHang();

        const { id } = await enqueue({ idempotencyKey: "resume", nameAttrValue: "once", attrs: { __NAME__: "once" } });
        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        // One create attempt total, then a search. A second create here is the
        // duplicate account the whole mechanism exists to prevent.
        expect(connector.controls.countOf("create")).toBe(1);
        expect(connector.controls.countOf("search")).toBe(1);
        expect(connector.controls.target.size).toBe(1);
    });
});

describe("reaper (BUG-2)", () => {
    /** Simulate a dispatcher that claimed rows and then died. */
    function orphan(): void {
        for (const row of store.allRows()) {
            if (row.status === "RUNNING") (row as any).claimedAt = new Date(Date.now() - 3_600_000);
        }
    }

    it("returns an abandoned delete to the backlog and completes it", async () => {
        setup({ runtime: { attemptDeadlineMs: 50 } });
        const created = await connector.create!(OC, { __NAME__: "orphaned" });

        const { id } = await enqueue({ idempotencyKey: "reap-d", opType: "DELETE", uid: created.uid });

        // Claim it, then strand it as a dead replica would.
        await store.claimBatch(10, [], new Map([["ad-prod", { batchFree: 5, totalFree: 5 }]]));
        orphan();

        dispatcher = new Dispatcher({
            store, manager, registry,
            config: { reaperThresholdMs: 1, reaperIntervalMs: 0, logger: { error: () => {} } },
        });

        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        expect(connector.controls.target.size).toBe(0);
    });

    it("sends an abandoned create to read-back rather than re-issuing it", async () => {
        setup({ runtime: { attemptDeadlineMs: 50 } });
        // The target applied the create before the dispatcher died.
        await connector.create!(OC, { __NAME__: "half" });
        const createsBefore = connector.controls.countOf("create");

        const { id } = await enqueue({ idempotencyKey: "reap-c", nameAttrValue: "half", attrs: { __NAME__: "half" } });
        await store.claimBatch(10, [], new Map([["ad-prod", { batchFree: 5, totalFree: 5 }]]));
        orphan();

        dispatcher = new Dispatcher({
            store, manager, registry,
            config: { reaperThresholdMs: 1, reaperIntervalMs: 0, readBackGraceMs: 5, logger: { error: () => {} } },
        });

        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("SUCCEEDED");
        expect((row!.result as any).viaReadBack).toBe(true);
        // Blind retry here is exactly how a duplicate account happens.
        expect(connector.controls.target.size).toBe(1);
        expect(connector.controls.countOf("create")).toBe(createsBefore);   // dispatcher issued none
    });

    it("leaves a live attempt alone", async () => {
        setup();
        await enqueue({ idempotencyKey: "live", nameAttrValue: "l", attrs: { __NAME__: "l" } });
        await store.claimBatch(10, [], new Map([["ad-prod", { batchFree: 5, totalFree: 5 }]]));

        // Freshly claimed: reclaiming it would put two dispatchers on one
        // mutation, which is worse than the stranded row it would be fixing.
        const reaped = await store.reapStale(600_000, 5_000);
        expect(reaped).toEqual({ deferredForReadback: 0, requeued: 0 });
    });

    it("does not disturb a row waiting out its read-back", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 } });
        connector.controls.applyThenHang();

        await enqueue({ idempotencyKey: "wait", nameAttrValue: "w", attrs: { __NAME__: "w" } });
        await dispatcher.runCycle();
        await new Promise(r => setTimeout(r, 40));

        const parked = store.allRows().find(r => r.status === "AWAITING_READBACK");
        expect(parked).toBeDefined();

        // It looks abandoned by wall-clock age, but reclaiming it mid-wait
        // would re-issue the create the deferral exists to avoid.
        const reaped = await store.reapStale(0, 5_000);
        expect(reaped).toEqual({ deferredForReadback: 0, requeued: 0 });

        await drain();
    });
});

describe("delta operations (BUG-3)", () => {
    it("keys ADD_VALUES and REMOVE_VALUES on the uid, like update and delete", () => {
        expect(laneKeyFor("ADD_VALUES", OC, { uid: "u1" })).toBe("uid:__ACCOUNT__:u1");
        expect(laneKeyFor("REMOVE_VALUES", OC, { uid: "u1" })).toBe("uid:__ACCOUNT__:u1");
        // Same lane as any other write to that object, so a grant and a
        // revoke on one account cannot overlap.
        expect(laneKeyFor("ADD_VALUES", OC, { uid: "u1" }))
            .toBe(laneKeyFor("UPDATE", OC, { uid: "u1" }));
        expect(() => laneKeyFor("ADD_VALUES", OC, {})).toThrow(/uid/);
    });

    it("adds a grant without clobbering the values already there", async () => {
        // The distinction that makes deltas worth having: a replace carrying
        // one group would have removed the other two.
        setup();
        const created = await connector.create!(OC, { __NAME__: "u", groups: ["eng", "vpn"] });

        const { id } = await enqueue({
            idempotencyKey: "add-1", opType: "ADD_VALUES", uid: created.uid,
            attrs: { groups: ["finance"] },
        });
        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        expect(connector.controls.target.accounts.get(created.uid)!["groups"])
            .toEqual(["eng", "vpn", "finance"]);
    });

    it("removes only the named values", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "u", groups: ["eng", "vpn", "finance"] });

        const { id } = await enqueue({
            idempotencyKey: "rm-1", opType: "REMOVE_VALUES", uid: created.uid,
            attrs: { groups: ["vpn"] },
        });
        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        expect(connector.controls.target.accounts.get(created.uid)!["groups"])
            .toEqual(["eng", "finance"]);
    });

    it("dispatches to the delta arm, not to update", async () => {
        setup();
        const created = await connector.create!(OC, { __NAME__: "u", groups: [] });
        await enqueue({
            idempotencyKey: "arm", opType: "ADD_VALUES", uid: created.uid,
            attrs: { groups: ["a"] },
        });
        await drain();

        expect(connector.controls.countOf("addAttributeValues")).toBe(1);
        expect(connector.controls.countOf("update")).toBe(0);
    });

    it("records INDETERMINATE with zero retries when the manifest does not declare idempotentDelta", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 }, capabilities: { idempotentDelta: false } });
        const created = await connector.create!(OC, { __NAME__: "u", groups: [] });
        connector.controls.hangUntilAborted();

        const { id } = await enqueue({
            idempotencyKey: "gate-off", opType: "ADD_VALUES", uid: created.uid,
            attrs: { groups: ["a"] },
        });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("INDETERMINATE");
        expect(row!.errorCode).toBe("DELTA_NOT_IDEMPOTENT");
        expect(row!.attemptCount).toBe(0);
        // Exactly one attempt. Reconciliation is the backstop.
        expect(connector.controls.countOf("addAttributeValues")).toBe(1);
    });

    it("retries when the manifest declares the delta idempotent", async () => {
        setup({ runtime: { attemptDeadlineMs: 20 }, capabilities: { idempotentDelta: true } });
        const created = await connector.create!(OC, { __NAME__: "u", groups: [] });
        connector.controls.hangUntilAborted();

        const { id } = await enqueue({
            idempotencyKey: "gate-on", opType: "ADD_VALUES", uid: created.uid,
            attrs: { groups: ["a"] },
        });
        await drain();

        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
        expect(connector.controls.countOf("addAttributeValues")).toBe(2);
    });

    it("never reads back a delta", async () => {
        // There is no naming attribute to search on and no existence question
        // to ask, so a search here would be meaningless.
        setup({ runtime: { attemptDeadlineMs: 20 }, capabilities: { idempotentDelta: false } });
        const created = await connector.create!(OC, { __NAME__: "u", groups: [] });
        connector.controls.hangUntilAborted();

        await enqueue({
            idempotencyKey: "no-readback", opType: "ADD_VALUES", uid: created.uid,
            attrs: { groups: ["a"] },
        });
        await drain();

        expect(connector.controls.countOf("search")).toBe(0);
    });

    it("records UNKNOWN_UID as a confirmed failure", async () => {
        setup();
        const { id } = await enqueue({
            idempotencyKey: "ghost", opType: "ADD_VALUES", uid: "nope",
            attrs: { groups: ["a"] },
        });
        await drain();

        const row = await store.getStatus(id);
        expect(row!.status).toBe("FAILED_CONFIRMED");
        expect(row!.errorCode).toBe("UNKNOWN_UID");
    });
});

describe("why the idempotentDelta gate exists", () => {
    it("a replayed grant doubles it against a list-valued target", async () => {
        // The connector here appends without deduplicating, which is what a
        // list-valued multi-value attribute does. Replaying the grant is not a
        // no-op -- it is a second grant.
        setup({ connectorOpts: { nonIdempotentDelta: true } });
        const created = await connector.create!(OC, { __NAME__: "u", groups: [] });

        await connector.addAttributeValues!(OC, created.uid, { groups: ["finance"] });
        await connector.addAttributeValues!(OC, created.uid, { groups: ["finance"] });

        expect(connector.controls.target.accounts.get(created.uid)!["groups"])
            .toEqual(["finance", "finance"]);
    });

    it("the gate stops the dispatcher replaying one", async () => {
        setup({
            runtime: { attemptDeadlineMs: 20 },
            capabilities: { idempotentDelta: false },
            connectorOpts: { nonIdempotentDelta: true },
        });
        const created = await connector.create!(OC, { __NAME__: "u", groups: [] });
        // The target applies it, then the answer never arrives.
        connector.controls.applyThenHang();

        const { id } = await enqueue({
            idempotencyKey: "no-double", opType: "ADD_VALUES", uid: created.uid,
            attrs: { groups: ["finance"] },
        });
        await drain();

        // Recorded as unresolved rather than retried, so the grant is applied
        // exactly once. A retry here would have made it two.
        expect((await store.getStatus(id))!.status).toBe("INDETERMINATE");
        expect(connector.controls.target.accounts.get(created.uid)!["groups"])
            .toEqual(["finance"]);
    });

    it("a set-valued target is safe to replay, which is what the flag asserts", async () => {
        setup({ capabilities: { idempotentDelta: true } });
        const created = await connector.create!(OC, { __NAME__: "u", groups: [] });

        await connector.addAttributeValues!(OC, created.uid, { groups: ["finance"] });
        await connector.addAttributeValues!(OC, created.uid, { groups: ["finance"] });

        expect(connector.controls.target.accounts.get(created.uid)!["groups"])
            .toEqual(["finance"]);
    });
});
describe("interactive slice (BUG-4)", () => {
    /**
     * The discriminating test.
     *
     * Deliberately not a latency comparison. The claim query already orders
     * interactive rows first, which on its own produces a large p50 separation
     * under load -- the Phase 11 soak measured 825ms against 12,775ms with no
     * reservation in existence. Ordering decides who takes the next free slot;
     * a reservation decides whether a slot is free at all. Only the second
     * survives sustained batch saturation, and only this assertion can tell
     * them apart.
     */
    it("starts an interactive op before any in-flight batch attempt finishes", async () => {
        // Budget 5, default slice 0.2 -> 1 slot reserved, 4 available to batch.
        setup({ runtime: { mutationConcurrency: 5 } });
        connector.controls.latency(120);

        const order: string[] = [];
        const realCreate = connector.create!.bind(connector);
        (connector as any).create = async (...args: any[]) => {
            const name = String((args[1] as any).__NAME__);
            order.push(`start:${name}`);
            const r = await realCreate(...(args as [any, any, any]));
            order.push(`end:${name}`);
            return r;
        };

        // Saturate with batch work: more rows than the whole budget.
        for (let i = 0; i < 10; i++) {
            await enqueue({ idempotencyKey: `b${i}`, priority: "batch",
                nameAttrValue: `batch${i}`, attrs: { __NAME__: `batch${i}` } });
        }
        await dispatcher.runCycle();

        // Batch is now running and holding slots. The interactive op arrives
        // mid-flight, exactly as a helpdesk write would.
        await enqueue({ idempotencyKey: "i0", priority: "interactive",
            nameAttrValue: "urgent", attrs: { __NAME__: "urgent" } });
        await dispatcher.runCycle();
        await drain();

        const interactiveStart = order.indexOf("start:urgent");
        const firstBatchEnd = order.findIndex(e => e.startsWith("end:batch"));

        expect(interactiveStart).toBeGreaterThanOrEqual(0);
        expect(firstBatchEnd).toBeGreaterThanOrEqual(0);
        // Without the reservation the interactive op cannot start until a
        // batch attempt releases a slot, so this index comparison inverts.
        expect(interactiveStart).toBeLessThan(firstBatchEnd);
    });

    it("never runs more batch attempts at once than the slice allows", async () => {
        setup({ runtime: { mutationConcurrency: 5 } });
        connector.controls.latency(60);

        let inFlight = 0;
        let peak = 0;
        const realCreate = connector.create!.bind(connector);
        (connector as any).create = async (...args: any[]) => {
            inFlight++; peak = Math.max(peak, inFlight);
            try { return await realCreate(...(args as [any, any, any])); }
            finally { inFlight--; }
        };

        for (let i = 0; i < 12; i++) {
            await enqueue({ idempotencyKey: `b${i}`, priority: "batch",
                nameAttrValue: `batch${i}`, attrs: { __NAME__: `batch${i}` } });
        }
        await drain();

        // batchSlots = 5 - ceil(5 * 0.2) = 4.
        expect(peak).toBeLessThanOrEqual(4);
        expect(peak).toBeGreaterThan(0);
    });

    it("lets interactive work use the whole budget when batch is idle", async () => {
        setup({ runtime: { mutationConcurrency: 5 } });
        connector.controls.latency(60);

        let inFlight = 0;
        let peak = 0;
        const realCreate = connector.create!.bind(connector);
        (connector as any).create = async (...args: any[]) => {
            inFlight++; peak = Math.max(peak, inFlight);
            try { return await realCreate(...(args as [any, any, any])); }
            finally { inFlight--; }
        };

        for (let i = 0; i < 8; i++) {
            await enqueue({ idempotencyKey: `i${i}`, priority: "interactive",
                nameAttrValue: `urgent${i}`, attrs: { __NAME__: `urgent${i}` } });
        }
        await drain();

        // The slice caps batch, not interactive: interactive reaches 5.
        expect(peak).toBe(5);
    });

    it("gives batch the whole budget at a slice fraction of zero (RFE-1)", async () => {
        setup({ runtime: { mutationConcurrency: 4 } });
        connector.controls.latency(60);
        // Rebuild with an explicit zero slice for this instance.
        dispatcher = new Dispatcher({
            store, manager, registry,
            scheduling: () => ({ interactiveSliceFraction: 0 }),
            config: { backoffBaseMs: 10, backoffMaxMs: 20, logger: { error: () => {} } },
        });

        let inFlight = 0;
        let peak = 0;
        const realCreate = connector.create!.bind(connector);
        (connector as any).create = async (...args: any[]) => {
            inFlight++; peak = Math.max(peak, inFlight);
            try { return await realCreate(...(args as [any, any, any])); }
            finally { inFlight--; }
        };

        for (let i = 0; i < 8; i++) {
            await enqueue({ idempotencyKey: `b${i}`, priority: "batch",
                nameAttrValue: `batch${i}`, attrs: { __NAME__: `batch${i}` } });
        }
        await drain();

        // Reserving nothing means batch may fill the budget, which is what an
        // operator asking for zero asked for.
        expect(peak).toBe(4);
    });

    it("shares the single slot at a budget of 1", async () => {
        setup({ runtime: { mutationConcurrency: 1 } });
        connector.controls.latency(20);

        for (let i = 0; i < 3; i++) {
            await enqueue({ idempotencyKey: `b${i}`, priority: "batch",
                nameAttrValue: `batch${i}`, attrs: { __NAME__: `batch${i}` } });
        }
        await drain();

        // Nothing to divide, so batch is not locked out of the only slot.
        expect(connector.controls.countOf("create")).toBe(3);
    });
});
