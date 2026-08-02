/**
 * Metric names the claim loop owns.
 *
 * CP-5 split the metric namespace along the same line as the code: breaker
 * transitions, live instances, pool occupancy, and event-loop lag stay in the
 * framework, because it can observe them on its own. Backlog, claim, outcome,
 * attempt, and reaper metrics left with the dispatcher, because nothing in the
 * framework can see a queue.
 *
 * The `gcf.` prefix is kept deliberately. These names have appeared in soak
 * output and in the framework's own documentation, and renaming them would
 * break continuity with the recorded baselines for no gain.
 *
 * Import the framework's `METRICS` alongside this when both halves are needed;
 * the two objects are disjoint.
 */
export const OPS_METRICS = {
    /**
     * PENDING operations per instance and class.
     *
     * With oldest-pending age, the primary health signal: a backlog that is
     * merely large is fine if it is draining, and a small one that is not
     * draining is not.
     */
    BACKLOG_DEPTH: "gcf.operations.backlog_depth",
    /** Age of the oldest PENDING operation, in ms. */
    OLDEST_PENDING_AGE_MS: "gcf.operations.oldest_pending_age_ms",
    /** Wall time of one claim cycle, in ms. */
    CLAIM_CYCLE_MS: "gcf.dispatcher.claim_cycle_ms",
    /** Rows claimed per cycle. */
    CLAIMED: "gcf.dispatcher.claimed",
    /** Terminal outcomes, labelled by outcome and op type. */
    OUTCOME: "gcf.operations.outcome",
    /** Requeues, labelled by reason. */
    REQUEUED: "gcf.operations.requeued",
    /** Creates parked to await a read-back rather than holding a slot. */
    DEFERRED_READBACK: "gcf.operations.deferred_readback",
    /** Rows recovered from a dead dispatcher, labelled by the route taken. */
    REAPED: "gcf.operations.reaped",
    /** End-to-end attempt latency per instance, in ms. */
    ATTEMPT_LATENCY_MS: "gcf.operations.attempt_latency_ms",
    /**
     * Consecutive days ahead (from today) a partition already exists for.
     *
     * The signal for "the partition timer died," not the drop-refusal
     * counter below: a missing partition fails every enqueue against it with
     * no warning beforehand, so this is what alerting should watch for
     * reaching zero, days ahead of that outage actually starting.
     */
    PARTITION_DAYS_AHEAD: "gcf.operations.partition_days_ahead",
    /**
     * A partition past its retention window was NOT dropped because it still
     * holds a non-terminal row. Labelled with the row count -- the refusal
     * itself is correct (see drop_operations_partition's own comment), but
     * it must be loud: a silent refusal is exactly what let one abandoned
     * row pin a partition open indefinitely (framework BUG-2).
     */
    PARTITION_DROP_REFUSED: "gcf.operations.partition_drop_refused",
} as const;
