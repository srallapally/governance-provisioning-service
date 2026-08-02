// src/ops/PartitionMaintainer.ts
//
// Keeps the operations table's day-partitions alive without any external
// cron -- deployment is a single Docker container (P0), so an in-process
// timer is the only option, and this owns the whole of that job.
//
// Every pass does three things inside one transaction, holding a *blocking*
// advisory lock (not the reaper's pg_try_advisory_xact_lock, which skips a
// pass rather than waiting): ensure today's and the configured lookahead's
// partitions exist, drop whatever is both past retention and fully terminal,
// and report how many consecutive days ahead a partition already exists.
// Blocking rather than skipping is deliberate -- two replicas racing this
// should serialize and both see up-to-date state afterward, not have one
// silently do nothing for an hour.
import type { Pool, PoolClient } from "pg";
import type { MetricsSink } from "@governance-connector-framework/core";
import { OPS_METRICS as METRICS } from "./metrics.js";

/** Distinct from OperationStore's REAPER_LOCK_KEY -- an unrelated pass, an unrelated lock. */
const MAINTENANCE_LOCK_KEY = "9126535897932384";

export interface PartitionMaintainerConfig {
  /** Partitions older than this many days, and fully terminal, are dropped. */
  retentionDays: number;
  /** How many days past today to keep a partition ready for. Default 1 (today + tomorrow). */
  lookaheadDays?: number;
  /** How often to run a pass, in ms. Default 3_600_000 (hourly). */
  intervalMs?: number;
  /**
   * Upper bound on how many days ahead the "days ahead" gauge will ever
   * probe for. Just a safety cap on query size -- the gauge only matters
   * near zero, so this only needs to be comfortably larger than
   * `lookaheadDays` plus whatever jitter a missed pass or two could cause.
   */
  daysAheadProbeCap?: number;
  metrics: MetricsSink;
  logger: { warn(msg: string): void; error(msg: string): void };
}

const DEFAULTS = {
  lookaheadDays: 1,
  intervalMs: 3_600_000,
  daysAheadProbeCap: 30,
};

export class PartitionMaintainer {
  private readonly retentionDays: number;
  private readonly lookaheadDays: number;
  private readonly intervalMs: number;
  private readonly daysAheadProbeCap: number;
  private readonly metrics: MetricsSink;
  private readonly logger: PartitionMaintainerConfig["logger"];

  private timer: ReturnType<typeof setInterval> | undefined;
  // Matches Dispatcher's convention: false until stop() runs, so runPass()
  // is directly callable (e.g. from a test) without going through start()
  // first -- there is no in-flight external work a fresh instance needs
  // start() to arm before it's safe to run a pass.
  private stopped = false;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly pool: Pool, config: PartitionMaintainerConfig) {
    this.retentionDays = config.retentionDays;
    this.lookaheadDays = config.lookaheadDays ?? DEFAULTS.lookaheadDays;
    this.intervalMs = config.intervalMs ?? DEFAULTS.intervalMs;
    this.daysAheadProbeCap = config.daysAheadProbeCap ?? DEFAULTS.daysAheadProbeCap;
    this.metrics = config.metrics;
    this.logger = config.logger;
  }

  /**
   * Runs one pass immediately (not just on the first `intervalMs` tick --
   * unlike the claim loop's sub-second interval, waiting a full hour before
   * the first check would leave the days-ahead gauge stale exactly when a
   * container that just restarted most needs it accurate) and then on the
   * configured interval.
   */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.inFlight = this.runPass();
    this.timer = setInterval(() => { this.inFlight = this.runPass(); }, this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stops scheduling future passes and waits for whichever one is currently
   * running to finish. Nothing here does external target work the way a
   * connector attempt does, so unlike `Dispatcher.stop()` there is no
   * budget to bound the wait against -- a pass is a handful of local SQL
   * statements under a lock this process itself is the only realistic
   * holder of (single-container deployment), not a call to a slow remote
   * target.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await this.inFlight;
  }

  /**
   * One maintenance pass. Errors are caught and logged, not thrown: this
   * runs off a bare `setInterval` with no caller ever awaiting an individual
   * pass's result, so an uncaught rejection here would surface only as an
   * unhandled-rejection warning (or a crash, depending on Node's
   * configuration) rather than anything actionable -- logging it here is
   * the only place it can be made visible.
   *
   * Public, like `Dispatcher.runCycle()`, so a test can trigger a pass
   * directly rather than waiting on `intervalMs`.
   */
  async runPass(): Promise<void> {
    if (this.stopped) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Blocking: this pass waits its turn rather than skipping, so a
      // concurrent caller's view of "days ahead" is never stale by a whole
      // interval just because it lost a race.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MAINTENANCE_LOCK_KEY]);

      await client.query(
          `SELECT create_operations_partition(d::date)
             FROM generate_series(current_date, current_date + $1::int, interval '1 day') AS d`,
          [this.lookaheadDays],
      );

      // Cast to text explicitly: node-postgres parses a bare `date` column
      // into a JS Date by default (a well-known footgun -- it round-trips
      // through the process's local timezone), and every use of `day` below
      // treats it as an opaque 'YYYY-MM-DD' string (a metric label, a log
      // line, a parameter re-cast back to ::date). Keeping it a string end
      // to end sidesteps that entirely rather than converting back and forth.
      const candidates = await client.query<{ day: string }>(
          `SELECT DISTINCT to_char(to_date(substring(tablename FROM 12), 'YYYYMMDD'), 'YYYY-MM-DD') AS day
             FROM pg_tables
            WHERE schemaname = current_schema()
              AND tablename ~ '^operations_[0-9]{8}$'
              AND to_date(substring(tablename FROM 12), 'YYYYMMDD') < current_date - $1::int
            ORDER BY day`,
          [this.retentionDays],
      );

      for (const { day } of candidates.rows) {
        const dropped = await client.query<{ dropped: boolean }>(
            "SELECT drop_operations_partition($1::date) AS dropped",
            [day],
        );
        if (dropped.rows[0]?.dropped === true) continue;

        // Refused. Loud on purpose -- see drop_operations_partition's own
        // comment and framework BUG-2: a silent refusal (just a RAISE
        // NOTICE nothing reads) is exactly what let one abandoned row pin a
        // partition's retention open indefinitely with no trace.
        const liveRows = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n
               FROM operations
              WHERE created_at >= $1::date AND created_at < $1::date + 1
                AND NOT terminal`,
            [day],
        );
        const n = Number(liveRows.rows[0]?.n ?? 0);
        this.logger.warn(
            `[partitions] retained operations_${day.replaceAll("-", "")}: ${n} non-terminal row(s)`);
        this.metrics.counter(METRICS.PARTITION_DROP_REFUSED, 1, { day });
      }

      const daysAhead = await this.computeDaysAhead(client);
      this.metrics.gauge(METRICS.PARTITION_DAYS_AHEAD, daysAhead);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => { /* connection may already be broken */ });
      this.logger.error(`[partitions] maintenance pass failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Consecutive days ahead of (and including) today a partition already
   * exists for, stopping at the first gap. Queried fresh every pass rather
   * than tracked in memory, so it reflects reality even after a pass that
   * did no ensure/drop work at all -- the gauge's whole point is to be
   * trustworthy when nothing else is watching.
   */
  private async computeDaysAhead(client: PoolClient): Promise<number> {
    const probe = await client.query<{ present: boolean }>(
        `SELECT to_regclass('operations_' || to_char(d, 'YYYYMMDD')) IS NOT NULL AS present
           FROM generate_series(current_date, current_date + $1::int, interval '1 day') AS d
          ORDER BY d`,
        [this.daysAheadProbeCap],
    );

    let count = 0;
    for (const row of probe.rows) {
      if (!row.present) break;
      count += 1;
    }
    return count;
  }
}
