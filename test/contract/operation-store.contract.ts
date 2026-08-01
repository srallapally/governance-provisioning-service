// test/contract/operation-store.contract.ts
//
// One behavioural suite, run against every OperationStore implementation.
//
// The in-memory store is what most dispatcher tests execute against, so if it
// disagrees with Postgres those tests prove nothing. This suite is the only
// thing that keeps them honest, which is why it asserts observable protocol
// behaviour -- claim ordering, lane exclusivity, terminal-state guards -- and
// never reaches for implementation details.

import { describe, it, expect, beforeEach } from "vitest";
import type {
  OperationStoreApi,
  EnqueueInput,
  InstanceAvailability,
} from "../../src/ops/OperationStore.js";

export interface ContractHarness {
  store: OperationStoreApi;
  /** Drop the hot row, leaving history, as the retention window would. */
  expireHotRow?(id: string): Promise<void> | void;
}

export type HarnessFactory = () => Promise<ContractHarness> | ContractHarness;

let counter = 0;
function op(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  counter++;
  return {
    instanceId: "ad-prod",
    objectClass: "__ACCOUNT__",
    opType: "CREATE",
    laneKey: `create:__ACCOUNT__:user${counter}`,
    idempotencyKey: `key-${counter}`,
    nameAttrValue: `user${counter}`,
    attrs: { __NAME__: `user${counter}` },
    ...overrides,
  };
}

/**
 * Availability with no batch reservation: every slot open to either class.
 *
 * This is what the store saw before P1.5 gave batch its own cap, so every
 * pre-existing case keeps asserting exactly what it asserted then. Cases that
 * exercise the reservation build the map with SLICED instead.
 */
const ALL = (instances: Record<string, number>): Map<string, InstanceAvailability> =>
    new Map(Object.entries(instances).map(([id, n]) => [id, { batchFree: n, totalFree: n }]));

/** Availability with a batch cap below the total: the reserved-slice shape. */
const SLICED = (
    instances: Record<string, { batchFree: number; totalFree: number }>,
): Map<string, InstanceAvailability> => new Map(Object.entries(instances));

/**
 * Register the shared contract under `name`.
 *
 * `factory` must hand back an empty store each time.
 */
export function runOperationStoreContract(name: string, factory: HarnessFactory): void {
  describe(`OperationStore contract: ${name}`, () => {
    let h: ContractHarness;
    let store: OperationStoreApi;

    beforeEach(async () => {
      h = await factory();
      store = h.store;
    });

    describe("enqueue", () => {
      it("returns a fresh id for a new idempotency key", async () => {
        const a = await store.enqueue(op({ idempotencyKey: "a" }));
        const b = await store.enqueue(op({ idempotencyKey: "b" }));
        expect(a.deduplicated).toBe(false);
        expect(b.deduplicated).toBe(false);
        expect(a.id).not.toBe(b.id);
      });

      it("returns the original id for a repeated idempotency key", async () => {
        // A retried enqueue must not create a second account.
        const first = await store.enqueue(op({ idempotencyKey: "same" }));
        const second = await store.enqueue(op({ idempotencyKey: "same" }));
        expect(second.id).toBe(first.id);
        expect(second.deduplicated).toBe(true);
      });

      it("starts operations PENDING with a zero attempt count", async () => {
        const { id } = await store.enqueue(op());
        const row = await store.getStatus(id);
        expect(row).toMatchObject({ status: "PENDING", attemptCount: 0 });
      });

      it("defaults priority to batch", async () => {
        const { id } = await store.enqueue(op());
        const [claimed] = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(claimed!.id).toBe(id);
        expect(claimed!.priority).toBe("batch");
      });
    });

    describe("claimBatch", () => {
      it("marks claimed rows RUNNING", async () => {
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect((await store.getStatus(id))!.status).toBe("RUNNING");
      });

      it("never claims the same row twice", async () => {
        await store.enqueue(op());
        const first = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        const second = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(0);
      });

      it("orders interactive ahead of older batch work", async () => {
        // The whole point of the priority class: a helpdesk write must not
        // queue behind a reconciliation backlog.
        await store.enqueue(op({ idempotencyKey: "old", laneKey: "lane-1" }));
        await store.enqueue(op({ idempotencyKey: "older", laneKey: "lane-2" }));
        await store.enqueue(op({ idempotencyKey: "urgent", laneKey: "lane-3", priority: "interactive" }));

        const claimed = await store.claimBatch(1, [], ALL({ "ad-prod": 5 }));
        expect(claimed).toHaveLength(1);
        expect(claimed[0]!.priority).toBe("interactive");
      });

      it("orders oldest first within a priority class", async () => {
        const first = await store.enqueue(op({ laneKey: "lane-a" }));
        await store.enqueue(op({ laneKey: "lane-b" }));
        const claimed = await store.claimBatch(1, [], ALL({ "ad-prod": 5 }));
        expect(claimed[0]!.id).toBe(first.id);
      });

      it("excludes lanes that are already running", async () => {
        await store.enqueue(op({ laneKey: "busy-lane" }));
        const claimed = await store.claimBatch(10, ["busy-lane"], ALL({ "ad-prod": 5 }));
        expect(claimed).toHaveLength(0);
      });

      it("claims at most one operation per lane in a single cycle", async () => {
        // Two writes against the same object must never run concurrently,
        // whether the collision comes from an active lane or from within the
        // same claim batch.
        await store.enqueue(op({ idempotencyKey: "s1", laneKey: "same-lane" }));
        await store.enqueue(op({ idempotencyKey: "s2", laneKey: "same-lane" }));

        const claimed = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(claimed).toHaveLength(1);
      });

      it("respects the per-instance cap", async () => {
        for (let i = 0; i < 5; i++) await store.enqueue(op({ laneKey: `lane-${i}` }));
        const claimed = await store.claimBatch(10, [], ALL({ "ad-prod": 2 }));
        expect(claimed).toHaveLength(2);
      });

      it("does not let a same-lane backlog consume an instance's cap", async () => {
        // Three operations on one lane plus one on another, cap of 2: the
        // cycle should still pick up the second lane rather than burning the
        // cap on rows it must discard.
        await store.enqueue(op({ idempotencyKey: "h1", laneKey: "hot" }));
        await store.enqueue(op({ idempotencyKey: "h2", laneKey: "hot" }));
        await store.enqueue(op({ idempotencyKey: "h3", laneKey: "hot" }));
        await store.enqueue(op({ idempotencyKey: "c1", laneKey: "cool" }));

        const claimed = await store.claimBatch(10, [], ALL({ "ad-prod": 2 }));
        expect(claimed.map(c => c.laneKey).sort()).toEqual(["cool", "hot"]);
      });

      it("caps each instance independently", async () => {
        await store.enqueue(op({ instanceId: "a", laneKey: "a1" }));
        await store.enqueue(op({ instanceId: "a", laneKey: "a2" }));
        await store.enqueue(op({ instanceId: "b", laneKey: "b1" }));

        const claimed = await store.claimBatch(10, [], ALL({ a: 1, b: 1 }));
        expect(claimed).toHaveLength(2);
        expect(claimed.map(c => c.instanceId).sort()).toEqual(["a", "b"]);
      });

      it("skips instances with no available slots", async () => {
        await store.enqueue(op({ instanceId: "a", laneKey: "a1" }));
        await store.enqueue(op({ instanceId: "b", laneKey: "b1" }));
        const claimed = await store.claimBatch(10, [], ALL({ a: 0, b: 3 }));
        expect(claimed.map(c => c.instanceId)).toEqual(["b"]);
      });

      it("claims nothing when no instance is eligible or the limit is zero", async () => {
        await store.enqueue(op());
        expect(await store.claimBatch(10, [], ALL({}))).toHaveLength(0);
        expect(await store.claimBatch(0, [], ALL({ "ad-prod": 5 }))).toHaveLength(0);
      });

      it("honours the global limit across instances", async () => {
        for (let i = 0; i < 4; i++) await store.enqueue(op({ instanceId: "a", laneKey: `a${i}` }));
        for (let i = 0; i < 4; i++) await store.enqueue(op({ instanceId: "b", laneKey: `b${i}` }));
        expect(await store.claimBatch(3, [], ALL({ a: 10, b: 10 }))).toHaveLength(3);
      });

      it("returns the payload the dispatcher needs", async () => {
        await store.enqueue(op({
          opType: "UPDATE",
          uid: "u-1",
          laneKey: "uid:__ACCOUNT__:u-1",
          attrs: { title: "staff" },
          nameAttrValue: null,
          idempotencyKey: "payload",
        }));
        const [claimed] = await store.claimBatch(1, [], ALL({ "ad-prod": 1 }));
        expect(claimed).toMatchObject({
          opType: "UPDATE",
          uid: "u-1",
          laneKey: "uid:__ACCOUNT__:u-1",
          attrs: { title: "staff" },
          idempotencyKey: "payload",
        });
      });
    });

    describe("interactive slice (BUG-4)", () => {
      it("caps batch rows at batchFree while interactive keeps the whole budget", async () => {
        // Eight batch rows, budget 6, a slice of 2 reserved: batch may take 4.
        for (let i = 0; i < 8; i++) {
          await store.enqueue(op({ laneKey: `uid:b${i}`, idempotencyKey: `b${i}`, priority: "batch" }));
        }
        const claimed = await store.claimBatch(
            10, [], SLICED({ "ad-prod": { batchFree: 4, totalFree: 6 } }));

        expect(claimed).toHaveLength(4);
        expect(claimed.every(c => c.priority === "batch")).toBe(true);
      });

      it("lets interactive fill the slice batch was held out of", async () => {
        for (let i = 0; i < 8; i++) {
          await store.enqueue(op({ laneKey: `uid:b${i}`, idempotencyKey: `b${i}`, priority: "batch" }));
        }
        for (let i = 0; i < 2; i++) {
          await store.enqueue(op({ laneKey: `uid:i${i}`, idempotencyKey: `i${i}`, priority: "interactive" }));
        }
        const claimed = await store.claimBatch(
            10, [], SLICED({ "ad-prod": { batchFree: 4, totalFree: 6 } }));

        // The whole budget is used, but only 4 of it by batch.
        expect(claimed).toHaveLength(6);
        expect(claimed.filter(c => c.priority === "batch")).toHaveLength(4);
        expect(claimed.filter(c => c.priority === "interactive")).toHaveLength(2);
      });

      it("lets interactive exceed batchFree, up to the full budget", async () => {
        // The slice restricts batch. It does not restrict interactive to the
        // remainder -- interactive answers to totalFree alone.
        for (let i = 0; i < 6; i++) {
          await store.enqueue(op({ laneKey: `uid:i${i}`, idempotencyKey: `i${i}`, priority: "interactive" }));
        }
        const claimed = await store.claimBatch(
            10, [], SLICED({ "ad-prod": { batchFree: 1, totalFree: 5 } }));

        expect(claimed).toHaveLength(5);
        expect(claimed.every(c => c.priority === "interactive")).toBe(true);
      });

      it("claims no batch at all when the slice takes the whole budget", async () => {
        for (let i = 0; i < 4; i++) {
          await store.enqueue(op({ laneKey: `uid:b${i}`, idempotencyKey: `b${i}`, priority: "batch" }));
        }
        expect(await store.claimBatch(
            10, [], SLICED({ "ad-prod": { batchFree: 0, totalFree: 4 } }))).toHaveLength(0);
      });

      it("behaves as before when there is no reservation", async () => {
        // batchFree === totalFree is the pre-P1.5 shape, and RFE-1's fraction
        // of zero resolves to exactly it. Batch must reach the full budget.
        for (let i = 0; i < 6; i++) {
          await store.enqueue(op({ laneKey: `uid:b${i}`, idempotencyKey: `b${i}`, priority: "batch" }));
        }
        expect(await store.claimBatch(10, [], ALL({ "ad-prod": 4 }))).toHaveLength(4);
      });

      it("treats a budget of 1 as shared, not reserved", async () => {
        // computeInteractiveSlots returns 0 at a budget of 1, so batchSlots
        // equals the budget and the single slot stays open to either class.
        await store.enqueue(op({ laneKey: "uid:b0", idempotencyKey: "b0", priority: "batch" }));
        expect(await store.claimBatch(
            10, [], SLICED({ "ad-prod": { batchFree: 1, totalFree: 1 } }))).toHaveLength(1);
      });
    });

    describe("finalize", () => {
      it("moves a running operation to its terminal outcome", async () => {
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));

        expect(await store.finalize(id, "SUCCEEDED", { uid: "minted-1" })).toBe(true);

        const row = await store.getStatus(id);
        expect(row).toMatchObject({ status: "SUCCEEDED" });
        expect(row!.finalizedAt).not.toBeNull();
      });

      it("records the error code on a confirmed failure", async () => {
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.finalize(id, "FAILED_CONFIRMED", undefined, "ALREADY_EXISTS");
        expect((await store.getStatus(id))!.errorCode).toBe("ALREADY_EXISTS");
      });

      it("refuses to re-finalize a terminal operation", async () => {
        // A redelivered finalize is a no-op, not an error, and must not
        // rewrite an outcome the caller may already have read.
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.finalize(id, "SUCCEEDED", { uid: "first" });

        expect(await store.finalize(id, "FAILED_CONFIRMED")).toBe(false);
        expect((await store.getStatus(id))!.status).toBe("SUCCEEDED");
      });

      it("reports false for an unknown id", async () => {
        expect(await store.finalize("does-not-exist", "SUCCEEDED")).toBe(false);
      });

      it("takes a finalized operation out of the claimable set", async () => {
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.finalize(id, "SUCCEEDED");
        expect(await store.claimBatch(10, [], ALL({ "ad-prod": 5 }))).toHaveLength(0);
      });
    });

    describe("requeue", () => {
      it("returns a running operation to the backlog and counts the retry", async () => {
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));

        expect(await store.requeue(id)).toBe(true);

        const row = await store.getStatus(id);
        expect(row).toMatchObject({ status: "PENDING", attemptCount: 1 });
      });

      it("makes the operation claimable again", async () => {
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.requeue(id);

        const [again] = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(again!.id).toBe(id);
        expect(again!.attemptCount).toBe(1);
      });

      it("refuses to requeue an operation that is not running", async () => {
        const { id } = await store.enqueue(op());
        expect(await store.requeue(id)).toBe(false);           // still PENDING
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.finalize(id, "SUCCEEDED");
        expect(await store.requeue(id)).toBe(false);           // terminal
      });
    });

    describe("deferForReadback", () => {
      it("parks a running create and releases its claim", async () => {
        const { id } = await store.enqueue(op({ laneKey: "lane-defer" }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));

        expect(await store.deferForReadback(id, new Date(Date.now() - 1_000))).toBe(true);
        expect((await store.getStatus(id))!.status).toBe("AWAITING_READBACK");
      });

      it("does not count the wait as an attempt", async () => {
        // The read-back path allows exactly one retry. Counting the wait would
        // spend that budget before the read-back ever ran -- the same trap that
        // made backoff consume its retries without retrying.
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.deferForReadback(id, new Date(Date.now() - 1_000));

        expect((await store.getStatus(id))!.attemptCount).toBe(0);
      });

      it("refuses to defer an operation that is not running", async () => {
        const { id } = await store.enqueue(op());
        expect(await store.deferForReadback(id, new Date())).toBe(false);
      });

      it("holds the row back until its wait has elapsed", async () => {
        const { id } = await store.enqueue(op({ laneKey: "lane-wait" }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.deferForReadback(id, new Date(Date.now() + 60_000));

        expect(await store.claimBatch(10, [], ALL({ "ad-prod": 5 }))).toHaveLength(0);
      });

      it("reclaims the row once the wait is over, marked as a resume", async () => {
        const { id } = await store.enqueue(op({ laneKey: "lane-due" }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.deferForReadback(id, new Date(Date.now() - 1));

        const [again] = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(again!.id).toBe(id);
        // The marker that tells the dispatcher to search rather than re-create.
        expect(again!.priorStatus).toBe("AWAITING_READBACK");
      });

      it("marks an ordinary claim as PENDING, not a resume", async () => {
        await store.enqueue(op());
        const [claimed] = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(claimed!.priorStatus).toBe("PENDING");
      });

      it("keeps the lane blocked while the wait runs", async () => {
        // A second create on the same name must not run while the first one's
        // outcome is unknown -- and this hold has to be durable, since the
        // deferral outlives the cycle that made it.
        const { id } = await store.enqueue(op({ idempotencyKey: "first", laneKey: "shared-lane" }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.deferForReadback(id, new Date(Date.now() + 60_000));

        await store.enqueue(op({ idempotencyKey: "second", laneKey: "shared-lane" }));

        expect(await store.claimBatch(10, [], ALL({ "ad-prod": 5 }))).toHaveLength(0);
      });

      it("does not block unrelated lanes", async () => {
        const { id } = await store.enqueue(op({ idempotencyKey: "held", laneKey: "lane-a" }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.deferForReadback(id, new Date(Date.now() + 60_000));

        await store.enqueue(op({ idempotencyKey: "free", laneKey: "lane-b" }));

        const claimed = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(claimed.map(c => c.laneKey)).toEqual(["lane-b"]);
      });

      it("counts a deferred read-back toward the backlog", async () => {
        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.deferForReadback(id, new Date(Date.now() + 60_000));

        // Unresolved work the caller is still waiting on; admitting more
        // against an instance accumulating these would hide the problem.
        expect(await store.pendingCounts("ad-prod")).toEqual({ interactive: 0, batch: 1 });
      });
    });

    describe("reapStale", () => {
      it("leaves a freshly claimed row alone", async () => {
        await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));

        expect(await store.reapStale(60_000, 5_000)).toEqual({
          deferredForReadback: 0, requeued: 0,
        });
      });

      it("sends an abandoned create to the read-back path", async () => {
        // Its outcome is unknown, and blind retry is how duplicate accounts
        // happen -- so it must be read back, not re-issued.
        const { id } = await store.enqueue(op({ opType: "CREATE" }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));

        const reaped = await store.reapStale(0, 60_000);
        expect(reaped.deferredForReadback).toBe(1);
        expect((await store.getStatus(id))!.status).toBe("AWAITING_READBACK");
      });

      it("returns an abandoned update or delete straight to the backlog", async () => {
        // Replace and delete are idempotent, so replaying them is safe.
        const a = await store.enqueue(op({
          idempotencyKey: "u", opType: "UPDATE", uid: "u1", laneKey: "uid:__ACCOUNT__:u1",
        }));
        const b = await store.enqueue(op({
          idempotencyKey: "d", opType: "DELETE", uid: "u2", laneKey: "uid:__ACCOUNT__:u2",
        }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));

        const reaped = await store.reapStale(0, 60_000);
        expect(reaped.requeued).toBe(2);
        expect((await store.getStatus(a.id))!.status).toBe("PENDING");
        expect((await store.getStatus(b.id))!.status).toBe("PENDING");
      });

      it("does not charge the operation for the process dying", async () => {
        const { id } = await store.enqueue(op({
          opType: "DELETE", uid: "u9", laneKey: "uid:__ACCOUNT__:u9",
        }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.reapStale(0, 60_000);

        expect((await store.getStatus(id))!.attemptCount).toBe(0);
      });

      it("ignores rows that are not RUNNING, including deferred read-backs", async () => {
        const pending = await store.enqueue(op({ idempotencyKey: "p", laneKey: "lane-p" }));
        const deferred = await store.enqueue(op({ idempotencyKey: "w", laneKey: "lane-w" }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.deferForReadback(deferred.id, new Date(Date.now() + 60_000));

        // A row waiting out its read-back looks abandoned by age; reclaiming it
        // mid-wait would re-issue the create the deferral exists to avoid.
        const reaped = await store.reapStale(0, 60_000);
        expect(reaped.deferredForReadback).toBe(1);   // only the still-RUNNING one
        expect((await store.getStatus(deferred.id))!.status).toBe("AWAITING_READBACK");
        void pending;
      });

      it("makes a reaped update claimable again", async () => {
        const { id } = await store.enqueue(op({
          opType: "UPDATE", uid: "u1", laneKey: "uid:__ACCOUNT__:u1",
        }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.reapStale(0, 60_000);

        const [again] = await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(again!.id).toBe(id);
        expect(again!.priorStatus).toBe("PENDING");
      });
    });

    describe("pendingCounts", () => {
      it("counts only PENDING rows, split by class", async () => {
        await store.enqueue(op({ laneKey: "l1" }));
        await store.enqueue(op({ laneKey: "l2" }));
        await store.enqueue(op({ laneKey: "l3", priority: "interactive" }));

        expect(await store.pendingCounts("ad-prod")).toEqual({ interactive: 1, batch: 2 });
      });

      it("stops counting an operation once it is claimed", async () => {
        await store.enqueue(op({ laneKey: "l1" }));
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        expect(await store.pendingCounts("ad-prod")).toEqual({ interactive: 0, batch: 0 });
      });

      it("is scoped to one instance", async () => {
        await store.enqueue(op({ instanceId: "a", laneKey: "a1" }));
        await store.enqueue(op({ instanceId: "b", laneKey: "b1" }));
        expect(await store.pendingCounts("a")).toEqual({ interactive: 0, batch: 1 });
      });

      it("reports zeroes for an unknown instance", async () => {
        expect(await store.pendingCounts("nobody")).toEqual({ interactive: 0, batch: 0 });
      });
    });

    describe("getStatus", () => {
      it("returns null for an unknown id", async () => {
        expect(await store.getStatus("nope")).toBeNull();
      });

      it("serves the outcome from history once the hot row has aged out", async () => {
        if (!h.expireHotRow) return; // implementation cannot simulate retention

        const { id } = await store.enqueue(op());
        await store.claimBatch(10, [], ALL({ "ad-prod": 5 }));
        await store.finalize(id, "SUCCEEDED", { uid: "minted-9" });

        await h.expireHotRow(id);

        const row = await store.getStatus(id);
        expect(row).toMatchObject({ status: "SUCCEEDED", fromHistory: true });
        // The payload is gone, but the minted Uid survives -- without it a
        // successful create is unlinkable to the account it made.
        expect(row!.result).toEqual({ uid: "minted-9" });
      });
    });
  });
}
