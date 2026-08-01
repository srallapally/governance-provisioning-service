// src/ops/OperationStore.ts
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { OperationPriority } from "@governance-connector-framework/core";
import type {
  OperationOutcome,
  OperationPendingStatus,
  OperationStatus,
} from "./types.js";

/**
 * Absolute path to the DDL that backs this store.
 *
 * The SQL lives at the repository root under `sql/` rather than beside this
 * file, so it is one artifact for both the store and `scripts/db-setup.sh`.
 * Two levels up lands on the root from either `src/ops` or `dist/ops`, so the
 * same expression works under tsx and after a build.
 */
export const OPERATIONS_SCHEMA_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "sql", "schema.sql",
);

/**
 * Mutation kinds the operation table records. Reads are synchronous and never
 * enqueued.
 *
 * `ADD_VALUES` and `REMOVE_VALUES` are admitted by the schema from Phase 11 so
 * that Phase 12, which teaches the dispatcher to execute them, changes no DDL.
 * Enqueuing one before then is accepted by the table and never dispatched.
 */
export type OperationType = "CREATE" | "UPDATE" | "DELETE" | "ADD_VALUES" | "REMOVE_VALUES";

const TERMINAL_STATUSES: readonly OperationOutcome[] = [
  "SUCCEEDED",
  "REJECTED_PRE_DISPATCH",
  "FAILED_CONFIRMED",
  "INDETERMINATE",
];

export interface EnqueueInput {
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  /** Serialization key; operations sharing one never run concurrently on an instance. */
  laneKey: string;
  /** Caller-supplied dedup key. Re-enqueueing the same key returns the original id. */
  idempotencyKey: string;
  priority?: OperationPriority | undefined;
  uid?: string | null | undefined;
  nameAttrValue?: string | null | undefined;
  attrs?: Record<string, unknown> | null | undefined;
}

export interface EnqueueResult {
  id: string;
  /** True when an existing operation with this idempotency key was returned instead of inserting. */
  deduplicated: boolean;
}

export interface ClaimedOperation {
  id: string;
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  priority: OperationPriority;
  laneKey: string;
  uid: string | null;
  nameAttrValue: string | null;
  attrs: Record<string, unknown> | null;
  attemptCount: number;
  createdAt: Date;
  idempotencyKey: string;
  /**
   * The status this row held before it was claimed.
   *
   * `AWAITING_READBACK` means this is a resumed create whose outcome is
   * unknown: the dispatcher must read the object back, never re-issue the
   * create. Anything else is a fresh attempt.
   */
  priorStatus: OperationPendingStatus;
}

/** Outcome of one reaper pass, by the route each row took. */
export interface ReapResult {
  /** Creates handed to the read-back path, since their outcome is unknown. */
  deferredForReadback: number;
  /** Idempotent mutations returned straight to the backlog. */
  requeued: number;
}

export interface OperationStatusRow {
  id: string;
  instanceId: string;
  objectClass: string;
  opType: OperationType;
  status: OperationStatus;
  attemptCount: number;
  result: unknown | null;
  errorCode: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
  /** True when the row came from operations_history because the hot row has aged out. */
  fromHistory: boolean;
}

export interface PendingCounts {
  interactive: number;
  batch: number;
}

/**
 * Derive a stable 64-bit advisory lock key from an idempotency key.
 *
 * Taken from a SHA-256 digest rather than a database-side hash so the value
 * depends only on documented APIs. Collisions are possible and harmless: two
 * unrelated keys sharing a lock serialize against each other briefly, which
 * costs a little concurrency and changes no outcome.
 */
function advisoryLockKey(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest().readBigInt64BE(0).toString();
}

/**
 * Advisory lock the reaper serializes on.
 *
 * A fixed arbitrary constant: every replica competes for this one lock, and
 * whoever holds it does that pass alone.
 */
const REAPER_LOCK_KEY = "7314159265358979";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True if `id` could be an operation id.
 *
 * Operation ids reach this layer straight from a URL path, and Postgres
 * answers a malformed uuid with a type error rather than an empty result. Left
 * unchecked that turns "operation 404" into "database error 500" on any
 * mistyped id, so a syntactically impossible id is treated as simply absent --
 * which it is.
 */
function isOperationId(id: string): boolean {
  return UUID_RE.test(id);
}

const CLAIM_SQL = `
WITH caps AS (
    SELECT * FROM unnest($1::text[], $2::int[]) AS t(instance_id, cap)
),
blocked_lanes AS (
    -- Lanes occupied by work that is not claimable right now: an attempt in
    -- flight, or a create waiting out its read-back delay.
    --
    -- This is what makes lane serialization survive a process restart. The
    -- dispatcher also passes its in-memory active set, but that dies with the
    -- process, and a deferred read-back outlives the cycle that deferred it --
    -- so without this a second create on the same name could run while the
    -- first one's outcome was still unknown.
    SELECT DISTINCT o.instance_id, o.lane_key
    FROM operations o
    WHERE o.status = 'RUNNING'
       OR (o.status = 'AWAITING_READBACK' AND o.not_before > now())
),
lane_leaders AS (
    -- At most one operation per (instance, lane) may enter a cycle. The lane
    -- exists to serialize writes against a single object, so claiming two of
    -- them together would defeat it just as surely as ignoring active lanes.
    SELECT o.id,
           o.created_at,
           o.priority,
           o.instance_id,
           o.status,
           c.cap,
           row_number() OVER (
               PARTITION BY o.instance_id, o.lane_key
               ORDER BY (o.priority = 'interactive') DESC, o.created_at
           ) AS lane_rn
    FROM operations o
    JOIN caps c ON c.instance_id = o.instance_id
    WHERE (
            o.status = 'PENDING'
            -- A deferred read-back becomes claimable once its wait is over.
            -- Ordering by created_at then picks it ahead of any later
            -- operation queued on the same lane, which is what lets it resume
            -- rather than be overtaken.
            OR (o.status = 'AWAITING_READBACK' AND o.not_before <= now())
          )
      AND NOT (o.lane_key = ANY($3::text[]))
      AND NOT EXISTS (
            SELECT 1 FROM blocked_lanes b
            WHERE b.instance_id = o.instance_id AND b.lane_key = o.lane_key
          )
),
ranked AS (
    -- Rank after collapsing lanes, not before: ranking first would let a
    -- backlog of same-lane operations consume an instance's cap with rows
    -- that are then discarded, under-filling the cycle.
    SELECT id,
           created_at,
           priority,
           status,
           cap,
           row_number() OVER (
               PARTITION BY instance_id
               ORDER BY (priority = 'interactive') DESC, created_at
           ) AS rn
    FROM lane_leaders
    WHERE lane_rn = 1
),
picked AS (
    SELECT id, created_at
    FROM ranked
    WHERE rn <= cap
    ORDER BY (priority = 'interactive') DESC, created_at
    LIMIT $4
),
locked AS (
    -- prior_status is captured here, before the UPDATE overwrites it. The
    -- dispatcher needs it to tell a fresh attempt from a resumed read-back:
    -- resuming must search for the object, never re-issue the create, which
    -- is the whole point of having deferred it.
    SELECT o.id, o.created_at, o.status AS prior_status
    FROM operations o
    JOIN picked p ON p.id = o.id AND p.created_at = o.created_at
    WHERE NOT o.terminal AND o.status <> 'RUNNING'
    FOR UPDATE OF o SKIP LOCKED
)
UPDATE operations o
SET status = 'RUNNING',
    claimed_at = now(),
    not_before = NULL
FROM locked l
WHERE o.id = l.id AND o.created_at = l.created_at
RETURNING o.id, o.instance_id, o.object_class, o.op_type, o.priority, o.lane_key,
          o.uid, o.name_attr_value, o.attrs, o.attempt_count, o.created_at,
          o.idempotency_key, l.prior_status
`;

/**
 * The operation-store contract.
 *
 * Extracted so the Postgres implementation and the in-memory test double are
 * held to one shared suite. Two implementations of a claim protocol drift
 * silently otherwise, and the in-memory one is what most dispatcher tests run
 * against -- if it disagrees with Postgres, those tests prove nothing.
 */
export interface OperationStoreApi {
  enqueue(op: EnqueueInput): Promise<EnqueueResult>;
  claimBatch(
      limit: number,
      activeLaneKeys: readonly string[],
      perInstanceAvailable: ReadonlyMap<string, number>,
  ): Promise<ClaimedOperation[]>;
  finalize(id: string, outcome: OperationOutcome, result?: unknown, errorCode?: string | null): Promise<boolean>;
  requeue(id: string): Promise<boolean>;
  deferForReadback(id: string, notBefore: Date): Promise<boolean>;
  reapStale(thresholdMs: number, readBackDelayMs: number): Promise<ReapResult>;
  pendingCounts(instanceId: string): Promise<PendingCounts>;
  getStatus(id: string): Promise<OperationStatusRow | null>;
}

/**
 * Durable store for asynchronous mutations.
 *
 * Takes a `pg.Pool` and never creates one: pool sizing belongs to the process
 * that owns the deployment, and the dispatcher wants its own small pool sized
 * against its claim concurrency rather than a share of the application's.
 *
 * Every statement is parameterized. No identifier or value is interpolated
 * into SQL text anywhere in this class.
 */
export class OperationStore implements OperationStoreApi {
  constructor(private readonly pool: Pool) {}

  /** Apply the DDL. Idempotent; safe to run on every boot. */
  static schemaPath(): string {
    return OPERATIONS_SCHEMA_PATH;
  }

  /**
   * Insert a PENDING operation, or return the id of the existing operation
   * carrying the same idempotency key.
   *
   * Serialized on a transaction-scoped advisory lock rather than a unique
   * constraint. A partitioned table can only enforce uniqueness on a key that
   * includes the partition column, and (idempotency_key, created_at) collides
   * only on an identical timestamp -- which never happens and would enforce
   * nothing if it did. The advisory lock gives the guarantee the unique index
   * cannot, and it is released with the transaction whether it commits or not.
   */
  async enqueue(op: EnqueueInput): Promise<EnqueueResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        advisoryLockKey(op.idempotencyKey),
      ]);

      const existing = await client.query(
          `SELECT id FROM operations WHERE idempotency_key = $1 ORDER BY created_at DESC LIMIT 1`,
          [op.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        await client.query("COMMIT");
        return { id: String(prior.id), deduplicated: true };
      }

      const inserted = await client.query(
          `INSERT INTO operations
               (instance_id, object_class, op_type, priority, lane_key,
                uid, name_attr_value, attrs, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            op.instanceId,
            op.objectClass,
            op.opType,
            op.priority ?? "batch",
            op.laneKey,
            op.uid ?? null,
            op.nameAttrValue ?? null,
            op.attrs === undefined || op.attrs === null ? null : JSON.stringify(op.attrs),
            op.idempotencyKey,
          ],
      );
      await client.query("COMMIT");

      const row = inserted.rows[0];
      if (!row) throw new Error("enqueue: insert returned no row");
      return { id: String(row.id), deduplicated: false };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* the original error is the useful one */ });
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Claim up to `limit` PENDING operations and mark them RUNNING.
   *
   * `activeLaneKeys` are lanes already executing; excluding them is what keeps
   * two operations against the same object from overlapping.
   *
   * `perInstanceAvailable` caps how many rows each instance may contribute to
   * this cycle. The dispatcher computes those numbers from each instance's
   * concurrency budget and interactive slice; the cap is applied here, before
   * the UPDATE, because a row marked RUNNING and then discarded by the caller
   * would be stranded in a non-terminal state.
   *
   * Concurrent dispatchers coordinate through SKIP LOCKED alone -- no leader
   * election, no external lock. Two replicas racing the same rows simply
   * partition them.
   *
   * `attempt_count` is not incremented here; it counts requeues, so a first
   * attempt runs at 0.
   */
  async claimBatch(
      limit: number,
      activeLaneKeys: readonly string[],
      perInstanceAvailable: ReadonlyMap<string, number>,
  ): Promise<ClaimedOperation[]> {
    const instanceIds: string[] = [];
    const caps: number[] = [];
    for (const [instanceId, available] of perInstanceAvailable) {
      if (available > 0) {
        instanceIds.push(instanceId);
        caps.push(available);
      }
    }
    // Every instance is saturated or rate limited: nothing can be claimed, and
    // the query would be a guaranteed-empty scan.
    if (instanceIds.length === 0 || limit <= 0) return [];

    const res = await this.pool.query(CLAIM_SQL, [
      instanceIds,
      caps,
      activeLaneKeys,
      limit,
    ]);

    return res.rows.map((r): ClaimedOperation => ({
      id: String(r.id),
      instanceId: String(r.instance_id),
      objectClass: String(r.object_class),
      opType: r.op_type as OperationType,
      priority: r.priority as OperationPriority,
      laneKey: String(r.lane_key),
      uid: r.uid ?? null,
      nameAttrValue: r.name_attr_value ?? null,
      attrs: r.attrs ?? null,
      attemptCount: Number(r.attempt_count),
      createdAt: r.created_at as Date,
      idempotencyKey: String(r.idempotency_key),
      priorStatus: r.prior_status as OperationPendingStatus,
    }));
  }

  /**
   * Move an operation to a terminal status and write its slim history row in
   * the same transaction, so a record can never reach a terminal state without
   * its permanent counterpart.
   *
   * Returns false if the operation was already terminal or does not exist --
   * a redelivered finalize is a no-op, not an error.
   *
   * The history row prefers the create result's Uid over the request's uid
   * column: on a create the target mints the Uid, and it is the one fact that
   * has to outlive the 24 hour hot window.
   */
  async finalize(
      id: string,
      outcome: OperationOutcome,
      result?: unknown,
      errorCode?: string | null,
  ): Promise<boolean> {
    if (!isOperationId(id)) return false;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const updated = await client.query(
          `UPDATE operations
              SET status = $2,
                  result = COALESCE($3::jsonb, result),
                  error_code = $4,
                  finalized_at = now()
            WHERE id = $1
              AND NOT (status = ANY($5::text[]))
        RETURNING id, instance_id, object_class, op_type, status, uid, error_code,
                  created_at, finalized_at, result`,
          [
            id,
            outcome,
            result === undefined ? null : JSON.stringify(result),
            errorCode ?? null,
            TERMINAL_STATUSES,
          ],
      );

      const row = updated.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query(
          `INSERT INTO operations_history
               (id, instance_id, object_class, op_type, status, uid, error_code, created_at, finalized_at)
           SELECT $1, $2, $3, $4, $5, COALESCE($6, ($7::jsonb)->>'uid'), $8, $9, $10
           ON CONFLICT (id) DO NOTHING`,
          [
            row.id,
            row.instance_id,
            row.object_class,
            row.op_type,
            row.status,
            row.uid ?? null,
            row.result === null || row.result === undefined ? null : JSON.stringify(row.result),
            row.error_code ?? null,
            row.created_at,
            row.finalized_at,
          ],
      );

      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* the original error is the useful one */ });
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Return a RUNNING operation to PENDING for another attempt.
   *
   * Increments attempt_count, so the counter measures retries rather than
   * claims. Returns false if the operation was not RUNNING, which is what a
   * duplicate requeue looks like.
   */
  /**
   * Park a timed-out create until its read-back is due.
   *
   * The row gives up its claim, and with it the mutation slot and the
   * connector lease the dispatcher was holding purely to keep an inline sleep
   * alive. It keeps its lane -- `blocked_lanes` in the claim query sees an
   * AWAITING_READBACK row whose wait has not elapsed -- because a second
   * create on the same name must not run while this one's outcome is unknown.
   *
   * Deliberately does NOT increment attempt_count. The read-back path allows
   * exactly one retry, so counting the wait as an attempt would spend that
   * budget before the read-back ever ran. This is the same trap that made
   * backoff consume its retries without retrying.
   */
  async deferForReadback(id: string, notBefore: Date): Promise<boolean> {
    if (!isOperationId(id)) return false;
    const res = await this.pool.query(
        `UPDATE operations
            SET status = 'AWAITING_READBACK',
                claimed_at = NULL,
                not_before = $2
          WHERE id = $1 AND status = 'RUNNING'`,
        [id, notBefore],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Recover rows abandoned by a dispatcher that died mid-attempt.
   *
   * Without this a killed replica strands its claimed rows in RUNNING forever:
   * the claim query looks for PENDING, so nothing ever sees them again. The
   * caller polls a status that never changes, and -- worse -- the partition
   * drop gate correctly refuses to drop any partition holding a non-terminal
   * row, so one abandoned row pins its day open and the retention window
   * silently stops bounding anything.
   *
   * `thresholdMs` must exceed the longest legitimate attempt: the instance's
   * deadline ceiling plus the read-back grace. Reclaiming work that is still
   * running would put two dispatchers on one mutation, which is a worse bug
   * than the one being fixed, so the threshold is deliberately generous.
   *
   * Routing by op type is the same reasoning as the resolution protocol. A
   * create's outcome is unknown, and blind retry is exactly how duplicate
   * accounts happen, so it goes to the read-back path. Update and delete are
   * idempotent -- replace, and delete-then-UNKNOWN_UID -- so they return
   * straight to the backlog. Neither increments attempt_count: the process
   * died, which is not the operation's fault.
   *
   * Guarded by a transaction-scoped advisory lock so concurrent replicas do
   * not all reap the same rows. A replica that cannot take the lock skips the
   * pass; another one is already doing it.
   */
  async reapStale(thresholdMs: number, readBackDelayMs: number): Promise<ReapResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const lock = await client.query(
          "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
          [REAPER_LOCK_KEY],
      );
      if (lock.rows[0]?.acquired !== true) {
        await client.query("ROLLBACK");
        return { deferredForReadback: 0, requeued: 0 };
      }

      const cutoff = `${thresholdMs} milliseconds`;

      const deferred = await client.query(
          `UPDATE operations
              SET status = 'AWAITING_READBACK',
                  claimed_at = NULL,
                  not_before = now() + ($2 || ' milliseconds')::interval
            WHERE status = 'RUNNING'
              AND op_type = 'CREATE'
              AND claimed_at < now() - $1::interval`,
          [cutoff, String(readBackDelayMs)],
      );

      const requeued = await client.query(
          `UPDATE operations
              SET status = 'PENDING',
                  claimed_at = NULL,
                  not_before = NULL
            WHERE status = 'RUNNING'
              AND op_type <> 'CREATE'
              AND claimed_at < now() - $1::interval`,
          [cutoff],
      );

      await client.query("COMMIT");
      return {
        deferredForReadback: deferred.rowCount ?? 0,
        requeued: requeued.rowCount ?? 0,
      };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* the original error is the useful one */ });
      throw e;
    } finally {
      client.release();
    }
  }

  async requeue(id: string): Promise<boolean> {
    if (!isOperationId(id)) return false;
    const res = await this.pool.query(
        `UPDATE operations
            SET status = 'PENDING',
                claimed_at = NULL,
                attempt_count = attempt_count + 1
          WHERE id = $1 AND status = 'RUNNING'`,
        [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * PENDING depth for one instance, split by priority class.
   *
   * Backs the admission cap: the enqueue path rejects with 429 and the backlog
   * depth once a class is over its cap, which turns queue depth into the flow
   * control signal instead of letting it grow without bound.
   */
  async pendingCounts(instanceId: string): Promise<PendingCounts> {
    const res = await this.pool.query(
        // A deferred read-back counts toward the backlog: it is unresolved work
        // the caller is still waiting on, and admitting more against an
        // instance that is accumulating them would hide the problem.
        `SELECT priority, count(*)::int AS n
           FROM operations
          WHERE instance_id = $1
            AND status IN ('PENDING', 'AWAITING_READBACK')
          GROUP BY priority`,
        [instanceId],
    );

    const counts: PendingCounts = { interactive: 0, batch: 0 };
    for (const row of res.rows) {
      if (row.priority === "interactive") counts.interactive = Number(row.n);
      else if (row.priority === "batch") counts.batch = Number(row.n);
    }
    return counts;
  }

  /**
   * Look up one operation for the status endpoint.
   *
   * Falls back to operations_history when the hot row has aged out, so a
   * caller polling an operation id past the retention window still gets its
   * outcome rather than a 404. History rows carry no payload, so `result` is
   * null there even for a success -- the Uid is reported instead.
   */
  async getStatus(id: string): Promise<OperationStatusRow | null> {
    if (!isOperationId(id)) return null;
    const hot = await this.pool.query(
        `SELECT id, instance_id, object_class, op_type, status, attempt_count,
                result, error_code, created_at, finalized_at
           FROM operations
          WHERE id = $1`,
        [id],
    );

    const row = hot.rows[0];
    if (row) {
      return {
        id: String(row.id),
        instanceId: String(row.instance_id),
        objectClass: String(row.object_class),
        opType: row.op_type as OperationType,
        status: row.status as OperationStatus,
        attemptCount: Number(row.attempt_count),
        result: row.result ?? null,
        errorCode: row.error_code ?? null,
        createdAt: row.created_at as Date,
        finalizedAt: (row.finalized_at as Date | null) ?? null,
        fromHistory: false,
      };
    }

    const cold = await this.pool.query(
        `SELECT id, instance_id, object_class, op_type, status, uid, error_code,
                created_at, finalized_at
           FROM operations_history
          WHERE id = $1`,
        [id],
    );

    const histRow = cold.rows[0];
    if (!histRow) return null;

    return {
      id: String(histRow.id),
      instanceId: String(histRow.instance_id),
      objectClass: String(histRow.object_class),
      opType: histRow.op_type as OperationType,
      status: histRow.status as OperationStatus,
      attemptCount: 0,
      result: histRow.uid ? { uid: String(histRow.uid) } : null,
      errorCode: histRow.error_code ?? null,
      createdAt: histRow.created_at as Date,
      finalizedAt: (histRow.finalized_at as Date | null) ?? null,
      fromHistory: true,
    };
  }
}
