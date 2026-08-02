// src/ops/Dispatcher.ts
//
// Drains the operation table.
//
// Runs in-process, and multiple replicas coordinate through SKIP LOCKED alone
// -- no leader election, no external lock. Two dispatchers racing the same
// backlog simply partition it, and a dispatcher that dies mid-cycle loses only
// the rows it had claimed.

import type { ConnectorManager, Lease } from "@governance-connector-framework/core";
import type { ConnectorRegistry } from "@governance-connector-framework/core";
import { isDeadlineExpired } from "@governance-connector-framework/core";
import { isConnectorError } from "@governance-connector-framework/core";
import { RateLimiter } from "@governance-connector-framework/core";
// cmp is a value, but core's main entry re-exports filter/ast with
// `export type *`, so it is only importable as a value from the subpath.
import { cmp } from "@governance-connector-framework/core/filter";
import type { OperationOptions, OperationPriority } from "@governance-connector-framework/core";
import type { OperationOutcome } from "./types.js";
import {
  resolveSchedulingConfig,
  type ResolvedInstanceConfig,
  type SchedulingConfigInput,
} from "../config/scheduling.js";
import type {
  ClaimedOperation,
  InstanceAvailability,
  OperationStoreApi,
} from "./OperationStore.js";
import { resolveNameAttribute } from "./nameAttribute.js";
import { noopMetrics, type MetricsSink } from "@governance-connector-framework/core";
// The claim-loop metric names left the framework at CP-5 with this code.
import { OPS_METRICS as METRICS } from "./metrics.js";

export interface DispatcherConfig {
  /** How often to attempt a claim cycle. Default 25ms. */
  claimIntervalMs?: number | undefined;
  /** Maximum rows claimed per cycle across all instances. Default 100. */
  claimBatchSize?: number | undefined;
  /** Retry ceiling for the ordinary backoff path. Default 5. */
  maxAttempts?: number | undefined;
  /** First backoff step. Default 1000ms. */
  backoffBaseMs?: number | undefined;
  /** Backoff ceiling. Default 60000ms. */
  backoffMaxMs?: number | undefined;
  /**
   * Extra delay added to the attempt deadline before a create read-back.
   * Default 2000ms.
   *
   * The read-back must never run before the attempt could possibly have
   * finished, or it reads the target mid-write and concludes the create
   * missed.
   */
  readBackGraceMs?: number | undefined;
  /**
   * How long a row may sit `RUNNING` before the reaper assumes its dispatcher
   * died. Default 10 minutes.
   *
   * Must exceed the longest legitimate attempt -- the instance's deadline
   * ceiling plus the read-back grace -- because reclaiming work that is still
   * running puts two dispatchers on one mutation, which is worse than the
   * stranded row it would be fixing.
   */
  reaperThresholdMs?: number | undefined;
  /** How often to run a reaper pass. Default 60s. */
  reaperIntervalMs?: number | undefined;
  /** Clock seam for tests. */
  now?: (() => number) | undefined;
  logger?: { error(msg: string): void } | undefined;
  /** Where measurements go. Defaults to discarding them. */
  metrics?: MetricsSink | undefined;
}

/**
 * Config with every default applied.
 *
 * Spelled out rather than `Required<DispatcherConfig>`: the input fields are
 * declared `number | undefined` for exactOptionalPropertyTypes, and `Required`
 * strips the optionality without stripping the undefined from the type.
 */
interface ResolvedDispatcherConfig {
  claimIntervalMs: number;
  claimBatchSize: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  readBackGraceMs: number;
  reaperThresholdMs: number;
  reaperIntervalMs: number;
}

/** Roughly one backlog sample per second at the default 25ms claim interval. */
const BACKLOG_SAMPLE_EVERY_N_CYCLES = 40;

const DEFAULTS = {
  claimIntervalMs: 25,
  claimBatchSize: 100,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  readBackGraceMs: 2_000,
  reaperThresholdMs: 10 * 60_000,
  reaperIntervalMs: 60_000,
} as const;

export interface DispatcherDeps {
  store: OperationStoreApi;
  manager: ConnectorManager;
  registry: ConnectorRegistry;
  config?: DispatcherConfig | undefined;
  /**
   * Per-instance scheduling settings.
   *
   * CP-5 left these out of core, so the registry's definition carries only
   * the execution half. Supply this to give an instance a rate limit or a
   * non-default interactive slice; omit it and every instance resolves the
   * documented defaults against its own mutation budget, which is exactly
   * what core used to do before the split.
   */
  scheduling?: ((instanceId: string) => SchedulingConfigInput | undefined) | undefined;
}

/** What one attempt concluded, before it is written to the store. */
interface Resolution {
  outcome: OperationOutcome | "REQUEUE" | "DEFER_READBACK";
  result?: unknown;
  errorCode?: string | null;
  /** Delay before the row becomes claimable again, for REQUEUE and DEFER_READBACK. */
  delayMs?: number;
}

export class Dispatcher {
  private readonly store: OperationStoreApi;
  private readonly manager: ConnectorManager;
  private readonly registry: ConnectorRegistry;
  private readonly schedulingOf: (instanceId: string) => SchedulingConfigInput | undefined;
  /**
   * Merged config per instance, keyed by instance id and mutation budget.
   *
   * Resolving the slice is pure arithmetic, but it happens on the claim path
   * for every instance on every cycle -- at 25ms intervals that is often
   * enough to be worth not repeating. The budget is part of the key so a
   * re-registered instance with a different budget re-resolves rather than
   * serving a stale slice.
   */
  private readonly configCache = new Map<string, ResolvedInstanceConfig>();
  private readonly cfg: ResolvedDispatcherConfig;
  private readonly now: () => number;
  private readonly logger: { error(msg: string): void };
  private readonly metrics: MetricsSink;

  /** Lanes with an attempt in flight, excluded from the next claim. */
  private readonly activeLanes = new Set<string>();
  /** In-flight attempts per instance, so budgets reflect reality. */
  private readonly running = new Map<string, number>();
  /**
   * In-flight *batch* attempts per instance.
   *
   * Counted separately because the batch cap is a cap on batch work, not on
   * work in general: without this the reserved slice could be consumed by
   * batch rows claimed in an earlier cycle and still running, and the
   * reservation would hold only within a single cycle (BUG-4).
   */
  private readonly runningBatch = new Map<string, number>();
  /**
   * Lanes held out of claiming until a backoff elapses.
   *
   * Keyed by lane rather than by operation id, and enforced by excluding the
   * lane from the claim. Letting the row be claimed and then bounced would
   * requeue it -- incrementing attempt_count each time -- so a backoff would
   * silently consume the whole retry budget without ever reaching the target.
   */
  private readonly laneDeferredUntil = new Map<string, number>();
  private readonly limiters = new Map<string, RateLimiter>();
  /** Rotating start offset, so one instance cannot always claim first. */
  private roundRobinCursor = 0;
  private backlogSampleCountdown = 0;
  private lastReapAt = 0;

  private timer: ReturnType<typeof setInterval> | undefined;
  private cycleInFlight = false;
  private stopped = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: DispatcherDeps) {
    this.store = deps.store;
    this.manager = deps.manager;
    this.registry = deps.registry;
    this.schedulingOf = deps.scheduling ?? (() => undefined);

    const c = deps.config ?? {};
    this.cfg = {
      claimIntervalMs: c.claimIntervalMs ?? DEFAULTS.claimIntervalMs,
      claimBatchSize: c.claimBatchSize ?? DEFAULTS.claimBatchSize,
      maxAttempts: c.maxAttempts ?? DEFAULTS.maxAttempts,
      backoffBaseMs: c.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
      backoffMaxMs: c.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
      readBackGraceMs: c.readBackGraceMs ?? DEFAULTS.readBackGraceMs,
      reaperThresholdMs: c.reaperThresholdMs ?? DEFAULTS.reaperThresholdMs,
      reaperIntervalMs: c.reaperIntervalMs ?? DEFAULTS.reaperIntervalMs,
    };
    this.now = c.now ?? (() => Date.now());
    this.logger = c.logger ?? { error: (m) => console.error(m) };
    this.metrics = c.metrics ?? noopMetrics;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.runCycle(); }, this.cfg.claimIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop claiming and wait for in-flight attempts to settle.
   *
   * `drainBudgetMs`, if given, bounds the wait: `stop()` returns once every
   * attempt has settled or the budget elapses, whichever comes first. This
   * does not cancel anything -- no attempt is ever given an `abortSignal`
   * (see `optionsFor`), so a straggler keeps running in the background
   * regardless of which one wins the race. `inFlightCount` stays accurate
   * throughout for a caller that wants to know whether that happened.
   *
   * A bounded wait exists for one reason: this process has nothing above it
   * that will wait indefinitely for a graceful exit. Whatever the deployment
   * grants as a stop-grace-period arrives eventually as SIGKILL, and an
   * unbounded `stop()` racing that clock is worse than one that gives up on
   * its own terms and lets the caller proceed to close what it owns. A
   * straggler left running loses its store connection when that happens
   * (see `OperationStore` and `Dispatcher.finalize`/`safeRequeue`, both of
   * which already tolerate a closed pool) and is left `RUNNING` -- exactly
   * what `reapStale` exists to recover, not a new failure mode this
   * introduces.
   *
   * Omitting the budget preserves the original unbounded behaviour, which
   * every existing caller (all current tests) relies on.
   */
  async stop(opts?: { drainBudgetMs?: number }): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const settled = Promise.allSettled([...this.inFlight]);
    if (opts?.drainBudgetMs === undefined) {
      await settled;
      return;
    }
    await Promise.race([settled, this.sleep(opts.drainBudgetMs)]);
  }

  /** Attempts currently executing. */
  get inFlightCount(): number { return this.inFlight.size; }

  /**
   * Claim and dispatch one cycle's worth of work.
   *
   * Public so tests can step the loop deterministically instead of waiting on
   * a timer. Overlapping cycles are skipped rather than queued: the previous
   * cycle already holds the lanes and slots this one would compute from.
   */
  async runCycle(): Promise<number> {
    if (this.cycleInFlight || this.stopped) return 0;
    this.cycleInFlight = true;
    const cycleStart = this.now();
    try {
      await this.maybeReap();

      const available = this.computeAvailability();
      if (available.size === 0) return 0;

      // Sampled before the claim, so it reports the backlog rather than
      // whatever the claim left behind.
      await this.sampleBacklog(available);

      const claimed = await this.store.claimBatch(
          this.cfg.claimBatchSize,
          this.excludedLanes(),
          available,
      );

      this.metrics.histogram(METRICS.CLAIM_CYCLE_MS, this.now() - cycleStart);
      this.metrics.counter(METRICS.CLAIMED, claimed.length);

      for (const op of claimed) {
        // How long this row waited before anyone picked it up. Paired with
        // backlog depth this is the health signal: a large backlog that is
        // draining is fine, a small one that is not is not.
        this.metrics.gauge(
            METRICS.OLDEST_PENDING_AGE_MS,
            Math.max(0, this.now() - op.createdAt.getTime()),
            { instance: op.instanceId, priority: op.priority },
        );

        this.activeLanes.add(op.laneKey);
        this.running.set(op.instanceId, (this.running.get(op.instanceId) ?? 0) + 1);
        if (op.priority === "batch") {
          this.runningBatch.set(op.instanceId, (this.runningBatch.get(op.instanceId) ?? 0) + 1);
        }

        const task = this.execute(op).finally(() => {
          this.activeLanes.delete(op.laneKey);
          this.running.set(op.instanceId, Math.max(0, (this.running.get(op.instanceId) ?? 1) - 1));
          if (op.priority === "batch") {
            this.runningBatch.set(
                op.instanceId, Math.max(0, (this.runningBatch.get(op.instanceId) ?? 1) - 1));
          }
        });
        this.inFlight.add(task);
        void task.finally(() => this.inFlight.delete(task));
      }

      return claimed.length;
    } finally {
      this.cycleInFlight = false;
    }
  }

  /**
   * Free mutation slots per instance, in round-robin order.
   *
   * Interactive work may draw on the whole budget; batch work is capped at the
   * budget minus the reserved slice. Since the claim query orders interactive
   * first, offering the full budget lets a burst of interactive work use every
   * slot while a steady batch backlog still leaves the slice free.
   */
  private computeAvailability(): Map<string, InstanceAvailability> {
    const ids = this.registry.registeredIds();
    if (ids.length === 0) return new Map();

    // Rotate the starting point so a consistently busy instance early in the
    // list cannot monopolise the batch limit cycle after cycle.
    const offset = this.roundRobinCursor++ % ids.length;
    const ordered = [...ids.slice(offset), ...ids.slice(0, offset)];

    const out = new Map<string, InstanceAvailability>();
    for (const instanceId of ordered) {
      const runtime = this.configOf(instanceId);
      if (!runtime) continue;

      const inFlight = this.running.get(instanceId) ?? 0;
      const totalFree = runtime.mutationConcurrency - inFlight;
      if (totalFree <= 0) continue;

      if (!this.hasRateLimitTokens(instanceId, runtime)) continue;

      // Batch is held to its own budget; interactive draws on the whole one.
      // batchSlots is mutationConcurrency minus the reserved slice, so at a
      // slice of zero -- or a budget of 1, where there is nothing to divide --
      // this reduces to the old single-number behaviour exactly.
      const batchInFlight = this.runningBatch.get(instanceId) ?? 0;
      const batchFree = Math.max(0, Math.min(runtime.batchSlots - batchInFlight, totalFree));

      out.set(instanceId, { batchFree, totalFree });
    }
    return out;
  }

  /**
   * Core's execution config for an instance, plus this service's scheduling
   * config for it. Returns undefined when the instance is not registered.
   */
  private configOf(instanceId: string): ResolvedInstanceConfig | undefined {
    const runtime = this.registry.getDefinition(instanceId)?.runtime;
    if (!runtime) return undefined;

    const key = `${instanceId}:${runtime.mutationConcurrency}`;
    const hit = this.configCache.get(key);
    if (hit) return hit;

    const merged: ResolvedInstanceConfig = {
      ...runtime,
      ...resolveSchedulingConfig(this.schedulingOf(instanceId), runtime.mutationConcurrency),
    };
    this.configCache.set(key, merged);
    return merged;
  }

  /**
   * Token-bucket admission for instances that declare a target rate limit.
   *
   * Checked before the claim rather than before the attempt: a row claimed and
   * then held back would sit RUNNING while its lane stayed blocked.
   */
  private hasRateLimitTokens(instanceId: string, runtime: ResolvedInstanceConfig): boolean {
    const limits = runtime.rateLimits;
    const configured = limits.create ?? limits.update ?? limits.delete;
    if (!configured) return true;

    let limiter = this.limiters.get(instanceId);
    if (!limiter) {
      const perSecond = configured.requestLimit / (configured.requestPeriodMs / 1000);
      limiter = new RateLimiter(configured.requestLimit, perSecond);
      this.limiters.set(instanceId, limiter);
    }
    return limiter.tryConsume(1);
  }

  /**
   * Recover rows abandoned by a dispatcher that died mid-attempt.
   *
   * Runs on its own slow cadence rather than every cycle: the store serializes
   * replicas on an advisory lock, and a pass that finds nothing is still two
   * statements against the hot table.
   *
   * A reaper is not optional bookkeeping. Without it a killed replica strands
   * its claimed rows in `RUNNING` where no claim query will ever see them, and
   * because the partition drop gate correctly refuses to drop a partition
   * holding non-terminal rows, one stranded row quietly stops the retention
   * window from bounding anything (BUG-2).
   */
  private async maybeReap(): Promise<void> {
    const now = this.now();
    if (now - this.lastReapAt < this.cfg.reaperIntervalMs) return;
    this.lastReapAt = now;

    try {
      const result = await this.store.reapStale(
          this.cfg.reaperThresholdMs,
          this.readBackDelayCeilingMs(),
      );
      if (result.deferredForReadback > 0) {
        this.metrics.counter(METRICS.REAPED, result.deferredForReadback, { route: "readback" });
      }
      if (result.requeued > 0) {
        this.metrics.counter(METRICS.REAPED, result.requeued, { route: "requeue" });
      }
    } catch (e) {
      // Recovery failing must not take the drain loop with it.
      this.logger.error(`[dispatcher] reaper pass failed: ${(e as Error).message}`);
    }
  }

  /**
   * A read-back delay generous enough for any instance the reaper might touch.
   *
   * The reaper works on rows without knowing which instance tuned what, so it
   * takes the largest configured create deadline rather than guessing. Waiting
   * too long only delays a resolution; waiting too little reads the target
   * before it has finished and wrongly concludes the create missed.
   */
  private readBackDelayCeilingMs(): number {
    let largest = 0;
    for (const instanceId of this.registry.registeredIds()) {
      const runtime = this.configOf(instanceId);
      if (runtime) largest = Math.max(largest, runtime.attemptDeadlineMs.create);
    }
    return largest + this.cfg.readBackGraceMs;
  }

  /**
   * Emit backlog depth, on a slower cadence than the claim loop.
   *
   * pendingCounts is a query per instance, and at a 25ms claim interval
   * sampling every cycle would put more load on the database than the work it
   * is measuring.
   */
  private async sampleBacklog(available: ReadonlyMap<string, InstanceAvailability>): Promise<void> {
    if (this.backlogSampleCountdown-- > 0) return;
    this.backlogSampleCountdown = BACKLOG_SAMPLE_EVERY_N_CYCLES;

    for (const instanceId of available.keys()) {
      try {
        const counts = await this.store.pendingCounts(instanceId);
        this.metrics.gauge(METRICS.BACKLOG_DEPTH, counts.interactive, {
          instance: instanceId, priority: "interactive",
        });
        this.metrics.gauge(METRICS.BACKLOG_DEPTH, counts.batch, {
          instance: instanceId, priority: "batch",
        });
      } catch {
        // Measurement must never break the drain it is measuring.
      }
    }
  }

  /** Lanes that must not be claimed this cycle: in flight, or inside a backoff. */
  private excludedLanes(): string[] {
    const now = this.now();
    for (const [lane, until] of this.laneDeferredUntil) {
      if (now >= until) this.laneDeferredUntil.delete(lane);
    }
    return [...new Set([...this.activeLanes, ...this.laneDeferredUntil.keys()])];
  }

  private async execute(op: ClaimedOperation): Promise<void> {
    const startedAt = this.now();
    let lease: Lease | undefined;
    try {
      lease = await this.manager.acquire(op.instanceId);
    } catch (e) {
      // Never reached the target: nothing happened, so this is safe to retry
      // wholesale rather than leaving it indeterminate.
      await this.finalize(op, {
        outcome: "REJECTED_PRE_DISPATCH",
        errorCode: "ACQUIRE_FAILED",
        result: { message: (e as Error).message },
      });
      return;
    }

    try {
      const resolution = await this.attempt(op, lease);
      await this.finalize(op, resolution);
    } catch (e) {
      this.logger.error(`[dispatcher] operation ${op.id} failed unexpectedly: ${(e as Error).message}`);
      await this.finalize(op, {
        outcome: "INDETERMINATE",
        errorCode: "DISPATCH_ERROR",
        result: { message: (e as Error).message },
      });
    } finally {
      lease.release();
      // Measured around the whole attempt, including connector acquisition,
      // because that is the latency an operation actually experiences.
      this.metrics.histogram(METRICS.ATTEMPT_LATENCY_MS, this.now() - startedAt, {
        instance: op.instanceId,
        op: op.opType,
      });
    }
  }

  private optionsFor(op: ClaimedOperation, runtime: ResolvedInstanceConfig): OperationOptions {
    const kind = op.opType === "CREATE" ? "create" : op.opType === "UPDATE" ? "update" : "delete";
    return {
      deadlineEpochMs: this.now() + runtime.attemptDeadlineMs[kind],
      priority: op.priority as OperationPriority,
    };
  }

  private async attempt(op: ClaimedOperation, lease: Lease): Promise<Resolution> {
    const runtime = this.configOf(op.instanceId);
    if (!runtime) {
      return { outcome: "REJECTED_PRE_DISPATCH", errorCode: "UNKNOWN_INSTANCE" };
    }

    // A row reclaimed from AWAITING_READBACK is a create whose outcome is
    // unknown. It resumes at the read-back and never re-issues the create.
    if (op.priorStatus === "AWAITING_READBACK") {
      return this.resumeReadBack(op, lease, runtime);
    }

    const options = this.optionsFor(op, runtime);
    const attrs = (op.attrs ?? {}) as Record<string, any>;

    switch (op.opType) {
      case "CREATE":         return this.attemptCreate(op, lease, runtime, options, attrs);
      case "UPDATE":         return this.attemptUpdate(op, lease, options, attrs);
      case "DELETE":         return this.attemptDelete(op, lease, options);
      case "ADD_VALUES":
      case "REMOVE_VALUES":  return this.attemptDelta(op, lease, options, attrs);
    }
  }

  // ---- CREATE ------------------------------------------------------------

  private async attemptCreate(
      op: ClaimedOperation,
      lease: Lease,
      runtime: ResolvedInstanceConfig,
      options: OperationOptions,
      attrs: Record<string, any>,
  ): Promise<Resolution> {
    try {
      const created: any = await lease.facade.create(op.objectClass, attrs, options);
      // The target mints the Uid, so it exists only in this result. It is
      // persisted here and kept in history forever; losing it would leave a
      // successful create unlinkable to the account it made.
      return { outcome: "SUCCEEDED", result: { uid: created.uid, object: created } };
    } catch (e) {
      if (isConnectorError(e) && e.code === "ALREADY_EXISTS") {
        // Confirmed refusal. The rare delete-then-recreate race resolves
        // through the caller's own retry rather than a race classifier here.
        return { outcome: "FAILED_CONFIRMED", errorCode: "ALREADY_EXISTS" };
      }

      if (isDeadlineExpired(e)) return this.resolveCreateAfterDeadline(op, lease, runtime);

      if (isConnectorError(e) && e.retryable) {
        return this.backoffOrGiveUp(op, e.code, "INDETERMINATE");
      }

      return { outcome: "FAILED_CONFIRMED", errorCode: codeOf(e) };
    }
  }

  /**
   * Decide what a timed-out create actually did.
   *
   * The target may have applied it, so retrying blind is how duplicate
   * accounts happen. Instead: wait past the point the attempt could still have
   * been running, then look the object up by its naming attribute.
   */
  private async resolveCreateAfterDeadline(
      op: ClaimedOperation,
      lease: Lease,
      runtime: ResolvedInstanceConfig,
  ): Promise<Resolution> {
    const caps = this.registry.capabilitiesOf(op.instanceId);
    if (!caps.equalitySearchOnName) {
      // No way to ask. Reconciliation is the backstop.
      return { outcome: "INDETERMINATE", errorCode: "DEADLINE_NO_READBACK" };
    }
    if (op.nameAttrValue === null || op.nameAttrValue === undefined) {
      return { outcome: "INDETERMINATE", errorCode: "DEADLINE_NO_NAME" };
    }

    // Park the row and let go of everything. The wait used to be an inline
    // sleep, which held the mutation slot, the connector lease, and the claim
    // for its whole duration -- so a degraded target turned its own timeouts
    // into reduced drain, worst exactly when it was already worst (BUG-1).
    //
    // The lane is the one thing that must survive: a second create on this
    // name cannot run while this one's outcome is unknown. It does, because
    // the claim query treats a not-yet-due AWAITING_READBACK row as blocking
    // its lane.
    return {
      outcome: "DEFER_READBACK",
      errorCode: "AWAITING_READBACK",
      delayMs: runtime.attemptDeadlineMs.create + this.cfg.readBackGraceMs,
    };
  }

  /**
   * Resume a create whose read-back wait has elapsed.
   *
   * Reached only for a row claimed out of `AWAITING_READBACK`. It must search,
   * never create: re-issuing here is precisely the duplicate the deferral
   * exists to prevent (BUG-1). The status is the marker that distinguishes
   * this from a fresh attempt.
   */
  private async resumeReadBack(
      op: ClaimedOperation,
      lease: Lease,
      runtime: ResolvedInstanceConfig,
  ): Promise<Resolution> {
    if (op.nameAttrValue === null || op.nameAttrValue === undefined) {
      return { outcome: "INDETERMINATE", errorCode: "DEADLINE_NO_NAME" };
    }

    const nameAttribute = await resolveNameAttribute(lease, op.objectClass);

    try {
      const found = await this.readBackByName(lease, op.objectClass, nameAttribute, op.nameAttrValue, runtime);
      if (found) {
        return { outcome: "SUCCEEDED", result: { uid: found.uid, object: found, viaReadBack: true } };
      }
    } catch (e) {
      // The read-back itself failed, so we still do not know.
      return { outcome: "INDETERMINATE", errorCode: `READBACK_FAILED:${codeOf(e)}` };
    }

    // Confirmed absent, so the create genuinely did not land. Exactly one
    // retry: a second miss means something other than a lost attempt.
    if (op.attemptCount < 1) {
      return { outcome: "REQUEUE", errorCode: "READBACK_MISS", delayMs: 0 };
    }
    return { outcome: "INDETERMINATE", errorCode: "READBACK_MISS" };
  }

  private async readBackByName(
      lease: Lease,
      objectClass: string,
      nameAttribute: string,
      nameValue: string,
      runtime: ResolvedInstanceConfig,
  ): Promise<{ uid: string } | null> {
    const filter = cmp("EQ", [nameAttribute], nameValue);
    const res: any = await lease.facade.search(objectClass, filter, {
      pageSize: 2,
      deadlineEpochMs: this.now() + runtime.attemptDeadlineMs.search,
    });
    const results = res?.results ?? [];
    return results.length > 0 ? results[0] : null;
  }

  // ---- UPDATE ------------------------------------------------------------

  private async attemptUpdate(
      op: ClaimedOperation,
      lease: Lease,
      options: OperationOptions,
      attrs: Record<string, any>,
  ): Promise<Resolution> {
    try {
      const updated: any = await lease.facade.update(op.objectClass, op.uid!, attrs, options);
      return { outcome: "SUCCEEDED", result: { uid: updated?.uid ?? op.uid, object: updated } };
    } catch (e) {
      if (isConnectorError(e) && e.code === "UNKNOWN_UID") {
        return { outcome: "FAILED_CONFIRMED", errorCode: "UNKNOWN_UID" };
      }

      const retryable = isDeadlineExpired(e) || (isConnectorError(e) && e.retryable);
      if (!retryable) return { outcome: "FAILED_CONFIRMED", errorCode: codeOf(e) };

      // UPDATE is always a full replace, which is idempotent by construction,
      // so replaying one is safe. Deltas are their own op types and carry
      // their own retry gate.
      return this.backoffOrGiveUp(op, codeOf(e), "INDETERMINATE");
    }
  }

  // ---- ADD_VALUES / REMOVE_VALUES ----------------------------------------

  /**
   * Apply a delta to a multi-valued attribute.
   *
   * Modelled on ICF's UpdateAttributeValuesOp rather than on a flag riding an
   * ordinary update: a delta is a different operation against the target, not
   * a replace wearing a marker, and representing it as one is what let the
   * previous retry gate guard a code path that could never execute.
   */
  private async attemptDelta(
      op: ClaimedOperation,
      lease: Lease,
      options: OperationOptions,
      attrs: Record<string, any>,
  ): Promise<Resolution> {
    if (op.uid === null || op.uid === undefined || op.uid === "") {
      return { outcome: "REJECTED_PRE_DISPATCH", errorCode: "MISSING_UID" };
    }

    const adding = op.opType === "ADD_VALUES";

    try {
      const updated: any = adding
          ? await lease.facade.addAttributeValues(op.objectClass, op.uid, attrs, options)
          : await lease.facade.removeAttributeValues(op.objectClass, op.uid, attrs, options);
      return { outcome: "SUCCEEDED", result: { uid: updated?.uid ?? op.uid, object: updated } };
    } catch (e) {
      if (isConnectorError(e) && e.code === "UNKNOWN_UID") {
        return { outcome: "FAILED_CONFIRMED", errorCode: "UNKNOWN_UID" };
      }

      const retryable = isDeadlineExpired(e) || (isConnectorError(e) && e.retryable);
      if (!retryable) return { outcome: "FAILED_CONFIRMED", errorCode: codeOf(e) };

      // The gate. A delta is only safe to replay if the target applies it with
      // set semantics; against list semantics a replay doubles the grant, and
      // for entitlements that is a silent privilege change. Only the manifest
      // can assert which it is, and absence of an assertion has to read as no.
      //
      // There is deliberately no read-back here: unlike a create, there is no
      // naming attribute to search on and no "does it exist" question to ask.
      // Reconciliation is the backstop.
      if (!this.registry.capabilitiesOf(op.instanceId).idempotentDelta) {
        return { outcome: "INDETERMINATE", errorCode: "DELTA_NOT_IDEMPOTENT" };
      }

      return this.backoffOrGiveUp(op, codeOf(e), "INDETERMINATE");
    }
  }

  // ---- DELETE ------------------------------------------------------------

  private async attemptDelete(
      op: ClaimedOperation,
      lease: Lease,
      options: OperationOptions,
  ): Promise<Resolution> {
    try {
      await lease.facade.delete(op.objectClass, op.uid!, options);
      return { outcome: "SUCCEEDED", result: { uid: op.uid } };
    } catch (e) {
      // The desired end state is "object absent", and it is absent. Treating
      // this as a failure would make every retry of a successful delete look
      // like an error.
      if (isConnectorError(e) && e.code === "UNKNOWN_UID") {
        return { outcome: "SUCCEEDED", result: { uid: op.uid, alreadyAbsent: true } };
      }

      const retryable = isDeadlineExpired(e) || (isConnectorError(e) && e.retryable);
      if (!retryable) return { outcome: "FAILED_CONFIRMED", errorCode: codeOf(e) };

      // Delete is idempotent: a replay either removes it or reports
      // UNKNOWN_UID, which resolves to success above.
      return this.backoffOrGiveUp(op, codeOf(e), "INDETERMINATE");
    }
  }

  // ---- shared ------------------------------------------------------------

  /** Requeue with exponential backoff, or give up once the attempt cap is hit. */
  private backoffOrGiveUp(
      op: ClaimedOperation,
      errorCode: string,
      exhausted: OperationOutcome,
  ): Resolution {
    if (op.attemptCount + 1 >= this.cfg.maxAttempts) {
      return { outcome: exhausted, errorCode };
    }
    const delayMs = Math.min(
        this.cfg.backoffMaxMs,
        this.cfg.backoffBaseMs * Math.pow(2, op.attemptCount),
    );
    return { outcome: "REQUEUE", errorCode, delayMs };
  }

  private async finalize(op: ClaimedOperation, r: Resolution): Promise<void> {
    if (r.outcome === "DEFER_READBACK") {
      // No lane deferral here: the lane is held by the row's own
      // AWAITING_READBACK status, which the claim query honours durably. An
      // in-memory hold would be lost on restart, and the row would outlive it.
      this.metrics.counter(METRICS.DEFERRED_READBACK, 1, { instance: op.instanceId });
      try {
        await this.store.deferForReadback(op.id, new Date(this.now() + (r.delayMs ?? 0)));
      } catch (e) {
        this.logger.error(`[dispatcher] defer failed for ${op.id}: ${(e as Error).message}`);
      }
      return;
    }

    if (r.outcome === "REQUEUE") {
      if (r.delayMs && r.delayMs > 0) {
        this.laneDeferredUntil.set(op.laneKey, this.now() + r.delayMs);
      }
      this.metrics.counter(METRICS.REQUEUED, 1, {
        instance: op.instanceId,
        op: op.opType,
        reason: r.errorCode ?? "UNKNOWN",
      });
      await this.safeRequeue(op.id);
      return;
    }

    this.metrics.counter(METRICS.OUTCOME, 1, {
      instance: op.instanceId,
      op: op.opType,
      outcome: r.outcome,
    });

    try {
      await this.store.finalize(op.id, r.outcome, r.result, r.errorCode ?? null);
    } catch (e) {
      this.logger.error(`[dispatcher] finalize failed for ${op.id}: ${(e as Error).message}`);
    }
  }

  private async safeRequeue(id: string): Promise<void> {
    try {
      await this.store.requeue(id);
    } catch (e) {
      this.logger.error(`[dispatcher] requeue failed for ${id}: ${(e as Error).message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise(res => { setTimeout(res, ms); });
  }
}

function codeOf(e: unknown): string {
  if (isDeadlineExpired(e)) return "DEADLINE_EXPIRED";
  if (isConnectorError(e)) return e.code;
  return "UNKNOWN";
}
