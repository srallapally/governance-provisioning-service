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
} as const;
