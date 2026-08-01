// src/ops/admission.ts
//
// The enqueue-side gate. Backlog depth is the flow-control signal: rather than
// letting an unbounded queue absorb more work than the drain rate can clear,
// the API refuses and says how deep the backlog already is, so the caller can
// slow down instead of discovering the problem hours later as latency.

import type { OperationPriority } from "@governance-connector-framework/core";
import type { EnqueueInput, EnqueueResult, OperationStoreApi, OperationType } from "./OperationStore.js";

/** Default PENDING ceilings per instance, per priority class. */
export const ADMISSION_DEFAULTS = {
  batch: 10_000,
  interactive: 1_000,
} as const;

export interface AdmissionCaps {
  batch?: number | undefined;
  interactive?: number | undefined;
}

/**
 * The backlog for this instance and class is full.
 *
 * Carries the observed depth so the API layer can return it alongside a 429;
 * a bare rejection tells the caller to back off but not by how much.
 */
export class AdmissionRejectedError extends Error {
  readonly instanceId: string;
  readonly priority: OperationPriority;
  readonly backlogDepth: number;
  readonly cap: number;

  constructor(instanceId: string, priority: OperationPriority, backlogDepth: number, cap: number) {
    super(
        `Backlog for instance '${instanceId}' (${priority}) is at ${backlogDepth}, ` +
        `at or above its cap of ${cap}. Retry after the backlog drains.`,
    );
    this.name = "AdmissionRejectedError";
    this.instanceId = instanceId;
    this.priority = priority;
    this.backlogDepth = backlogDepth;
    this.cap = cap;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isAdmissionRejected(e: unknown): e is AdmissionRejectedError {
  return e instanceof AdmissionRejectedError;
}

/**
 * Build the lane key for an operation.
 *
 * Lanes serialize writes against one object. A create has no Uid yet -- the
 * target mints it -- so it keys on the client-supplied naming attribute, which
 * CP-1 locks as always present. Updates and deletes key on the Uid.
 *
 * The two forms are namespaced apart so a create and a delete can never
 * collide on a shared string.
 */
export function laneKeyFor(
    opType: OperationType,
    objectClass: string,
    identity: { uid?: string | null | undefined; nameAttrValue?: string | null | undefined },
): string {
  if (opType === "CREATE") {
    const name = identity.nameAttrValue;
    if (name === undefined || name === null || name === "") {
      throw new Error(
          `CREATE on '${objectClass}' requires a naming attribute value to build its lane key`,
      );
    }
    return `create:${objectClass}:${name}`;
  }

  const uid = identity.uid;
  if (uid === undefined || uid === null || uid === "") {
    throw new Error(`${opType} on '${objectClass}' requires a uid to build its lane key`);
  }
  return `uid:${objectClass}:${uid}`;
}

export type AdmitInput = Omit<EnqueueInput, "laneKey"> & { laneKey?: string | undefined };

/**
 * Check the admission cap and enqueue.
 *
 * The check is advisory under concurrency: two callers can both read a depth
 * just under the cap and both be admitted. That is deliberate -- serializing
 * every enqueue to make the cap exact would cost more than the small overshoot
 * it prevents, and the cap exists to bound a runaway producer, not to be a
 * precise quota.
 */
export async function admitAndEnqueue(
    store: OperationStoreApi,
    op: AdmitInput,
    caps: AdmissionCaps = {},
): Promise<EnqueueResult> {
  const priority: OperationPriority = op.priority ?? "batch";
  const cap = (priority === "interactive" ? caps.interactive : caps.batch)
      ?? ADMISSION_DEFAULTS[priority];

  const counts = await store.pendingCounts(op.instanceId);
  const depth = priority === "interactive" ? counts.interactive : counts.batch;

  if (depth >= cap) {
    throw new AdmissionRejectedError(op.instanceId, priority, depth, cap);
  }

  const laneKey = op.laneKey ?? laneKeyFor(op.opType, op.objectClass, op);
  return store.enqueue({ ...op, laneKey, priority });
}
