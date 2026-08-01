// test/harness/MemoryOperationStore.ts
//
// In-memory OperationStore, used by dispatcher tests so they can run without a
// database. It is held to the same contract suite as the Postgres store
// (test/contract/operation-store.contract.ts), which is the only thing keeping
// the two from drifting.
//
// Where Postgres gives an ordering or atomicity guarantee, this reproduces the
// observable consequence rather than the mechanism: claims are serialized by
// the single-threaded event loop instead of SKIP LOCKED, but a row can still
// only be claimed once.

import type {
  ClaimedOperation,
  EnqueueInput,
  EnqueueResult,
  OperationStatusRow,
  OperationStoreApi,
  OperationType,
  PendingCounts,
  ReapResult,
  InstanceAvailability,
} from "../../src/ops/OperationStore.js";
// The row vocabulary left core with the dispatcher at CP-5; only the caller's
// scheduling class still comes from the framework.
import type {
  OperationOutcome,
  OperationPendingStatus,
  OperationStatus,
} from "../../src/ops/types.js";
import type { OperationPriority } from "@governance-connector-framework/core";

const TERMINAL: ReadonlySet<string> = new Set<OperationOutcome>([
  "SUCCEEDED",
  "REJECTED_PRE_DISPATCH",
  "FAILED_CONFIRMED",
  "INDETERMINATE",
]);

interface Row {
  id: string;
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  priority: OperationPriority;
  status: OperationStatus;
  laneKey: string;
  uid: string | null;
  nameAttrValue: string | null;
  attrs: Record<string, unknown> | null;
  result: unknown | null;
  errorCode: string | null;
  attemptCount: number;
  createdAt: Date;
  claimedAt: Date | null;
  notBefore: Date | null;
  finalizedAt: Date | null;
  idempotencyKey: string;
}

interface HistoryRow {
  id: string;
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  status: OperationStatus;
  uid: string | null;
  errorCode: string | null;
  createdAt: Date;
  finalizedAt: Date;
}

export interface MemoryOperationStoreOptions {
  /** Clock seam, so ordering is deterministic under fake timers. */
  now?: () => number;
}

export class MemoryOperationStore implements OperationStoreApi {
  private readonly rows = new Map<string, Row>();
  private readonly history = new Map<string, HistoryRow>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private seq = 0;
  private readonly now: () => number;

  constructor(opts: MemoryOperationStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Test affordance: drop the hot row while keeping history, as retention would. */
  expireHotRow(id: string): void {
    this.rows.delete(id);
  }

  /** Test affordance: every row, insertion-ordered. */
  allRows(): ReadonlyArray<Readonly<Row>> {
    return Array.from(this.rows.values());
  }

  async enqueue(op: EnqueueInput): Promise<EnqueueResult> {
    const existingId = this.byIdempotencyKey.get(op.idempotencyKey);
    if (existingId !== undefined) return { id: existingId, deduplicated: true };

    const id = `op-${++this.seq}`;
    // Monotonic within a millisecond: two ops enqueued in the same tick must
    // still have a stable claim order, which real timestamps would not give.
    const createdAt = new Date(this.now() + this.seq / 1e6);

    this.rows.set(id, {
      id,
      instanceId: op.instanceId,
      objectClass: op.objectClass,
      opType: op.opType,
      priority: op.priority ?? "batch",
      status: "PENDING",
      laneKey: op.laneKey,
      uid: op.uid ?? null,
      nameAttrValue: op.nameAttrValue ?? null,
      attrs: op.attrs ?? null,
      result: null,
      errorCode: null,
      attemptCount: 0,
      createdAt,
      claimedAt: null,
      notBefore: null,
      finalizedAt: null,
      idempotencyKey: op.idempotencyKey,
    });
    this.byIdempotencyKey.set(op.idempotencyKey, id);
    return { id, deduplicated: false };
  }

  async claimBatch(
      limit: number,
      activeLaneKeys: readonly string[],
      perInstanceAvailable: ReadonlyMap<string, InstanceAvailability>,
  ): Promise<ClaimedOperation[]> {
    if (limit <= 0) return [];

    const busy = new Set(activeLaneKeys);
    const remaining = new Map<string, number>();
    // Batch rows answer to a second, tighter cap. Mirrors batch_cap and
    // class_rn in the SQL; the contract suite holds both to it.
    const batchRemaining = new Map<string, number>();
    for (const [instanceId, a] of perInstanceAvailable) {
      if (a.totalFree > 0) {
        remaining.set(instanceId, a.totalFree);
        batchRemaining.set(instanceId, Math.max(0, Math.min(a.batchFree, a.totalFree)));
      }
    }
    if (remaining.size === 0) return [];

    const now = this.now();

    // Lanes occupied by work that is not claimable: an attempt in flight, or a
    // create still waiting out its read-back delay. Mirrors blocked_lanes in
    // the SQL, and is what makes lane serialization outlive the cycle that
    // established it.
    const blockedLanes = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.status === "RUNNING") blockedLanes.add(laneOf(row));
      else if (row.status === "AWAITING_READBACK"
          && row.notBefore !== null && row.notBefore.getTime() > now) {
        blockedLanes.add(laneOf(row));
      }
    }

    const candidates = Array.from(this.rows.values())
        .filter(r => r.status === "PENDING"
            || (r.status === "AWAITING_READBACK"
                && (r.notBefore === null || r.notBefore.getTime() <= now)))
        .filter(r => remaining.has(r.instanceId))
        .filter(r => !busy.has(r.laneKey))
        .filter(r => !blockedLanes.has(laneOf(r)))
        .sort(compareClaimOrder);

    const claimed: ClaimedOperation[] = [];
    // A lane may appear more than once in the backlog; claiming two operations
    // on one lane in a single cycle would defeat the serialization the lane
    // exists for.
    const takenLanes = new Set<string>();

    for (const row of candidates) {
      if (claimed.length >= limit) break;
      const left = remaining.get(row.instanceId) ?? 0;
      if (left <= 0) continue;
      if (takenLanes.has(row.laneKey)) continue;

      // A batch row past the cap is skipped, not promoted: the slot it would
      // take is reserved for interactive work that has not arrived yet.
      const batchLeft = batchRemaining.get(row.instanceId) ?? 0;
      if (row.priority === "batch") {
        if (batchLeft <= 0) continue;
        batchRemaining.set(row.instanceId, batchLeft - 1);
      }

      const priorStatus = row.status as OperationPendingStatus;
      row.status = "RUNNING";
      row.claimedAt = new Date(now);
      row.notBefore = null;
      remaining.set(row.instanceId, left - 1);
      takenLanes.add(row.laneKey);
      claimed.push(toClaimed(row, priorStatus));
    }

    return claimed;
  }

  async deferForReadback(id: string, notBefore: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "RUNNING") return false;
    row.status = "AWAITING_READBACK";
    row.claimedAt = null;
    row.notBefore = notBefore;
    // No attempt_count increment: the read-back path allows exactly one retry,
    // and counting the wait would spend it before the read-back ran.
    return true;
  }

  async reapStale(thresholdMs: number, readBackDelayMs: number): Promise<ReapResult> {
    const now = this.now();
    const result: ReapResult = { deferredForReadback: 0, requeued: 0 };

    for (const row of this.rows.values()) {
      if (row.status !== "RUNNING") continue;
      if (row.claimedAt === null) continue;
      if (now - row.claimedAt.getTime() < thresholdMs) continue;

      if (row.opType === "CREATE") {
        // Outcome unknown; blind retry is the duplicate-account path.
        row.status = "AWAITING_READBACK";
        row.claimedAt = null;
        row.notBefore = new Date(now + readBackDelayMs);
        result.deferredForReadback++;
      } else {
        row.status = "PENDING";
        row.claimedAt = null;
        row.notBefore = null;
        result.requeued++;
      }
      // Neither path increments attempt_count: the process died, which is not
      // the operation's fault.
    }
    return result;
  }

  async finalize(
      id: string,
      outcome: OperationOutcome,
      result?: unknown,
      errorCode?: string | null,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    if (TERMINAL.has(row.status)) return false;

    row.status = outcome;
    if (result !== undefined) row.result = result;
    row.errorCode = errorCode ?? null;
    row.finalizedAt = new Date(this.now());

    const resultUid = extractUid(row.result);
    this.history.set(id, {
      id: row.id,
      instanceId: row.instanceId,
      objectClass: row.objectClass,
      opType: row.opType,
      status: row.status,
      uid: row.uid ?? resultUid,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      finalizedAt: row.finalizedAt,
    });
    return true;
  }

  async requeue(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "RUNNING") return false;
    row.status = "PENDING";
    row.attemptCount += 1;
    return true;
  }

  async pendingCounts(instanceId: string): Promise<PendingCounts> {
    const counts: PendingCounts = { interactive: 0, batch: 0 };
    for (const row of this.rows.values()) {
      if (row.instanceId !== instanceId) continue;
      if (row.status !== "PENDING" && row.status !== "AWAITING_READBACK") continue;
      if (row.priority === "interactive") counts.interactive++;
      else counts.batch++;
    }
    return counts;
  }

  async getStatus(id: string): Promise<OperationStatusRow | null> {
    const row = this.rows.get(id);
    if (row) {
      return {
        id: row.id,
        instanceId: row.instanceId,
        objectClass: row.objectClass,
        opType: row.opType,
        status: row.status,
        attemptCount: row.attemptCount,
        result: row.result,
        errorCode: row.errorCode,
        createdAt: row.createdAt,
        finalizedAt: row.finalizedAt,
        fromHistory: false,
      };
    }

    const hist = this.history.get(id);
    if (!hist) return null;
    return {
      id: hist.id,
      instanceId: hist.instanceId,
      objectClass: hist.objectClass,
      opType: hist.opType,
      status: hist.status,
      attemptCount: 0,
      result: hist.uid ? { uid: hist.uid } : null,
      errorCode: hist.errorCode,
      createdAt: hist.createdAt,
      finalizedAt: hist.finalizedAt,
      fromHistory: true,
    };
  }
}

/** Interactive ahead of batch, then oldest first -- the SQL's ORDER BY. */
function compareClaimOrder(a: Row, b: Row): number {
  const aI = a.priority === "interactive" ? 0 : 1;
  const bI = b.priority === "interactive" ? 0 : 1;
  if (aI !== bI) return aI - bI;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/** Lanes are scoped per instance, matching the (instance_id, lane_key) index. */
function laneOf(row: Row): string {
  return `${row.instanceId}\u0000${row.laneKey}`;
}

function toClaimed(row: Row, priorStatus: OperationPendingStatus): ClaimedOperation {
  return {
    id: row.id,
    instanceId: row.instanceId,
    objectClass: row.objectClass,
    opType: row.opType,
    priority: row.priority,
    laneKey: row.laneKey,
    uid: row.uid,
    nameAttrValue: row.nameAttrValue,
    attrs: row.attrs,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    idempotencyKey: row.idempotencyKey,
    priorStatus,
  };
}

function extractUid(result: unknown): string | null {
  if (result && typeof result === "object" && "uid" in result) {
    const uid = (result as { uid: unknown }).uid;
    if (typeof uid === "string") return uid;
  }
  return null;
}
