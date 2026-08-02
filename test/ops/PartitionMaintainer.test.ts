// test/ops/PartitionMaintainer.test.ts
//
// Partitions are a Postgres/DDL construct with no in-memory equivalent --
// unlike OperationStore/Dispatcher, there's no memory-backed double possible
// here, so every test in this file runs through describeWithPg.
//
// Dates are computed via Postgres's own current_date throughout, never via a
// JS Date, to avoid any timezone skew between this process and the server --
// the same convention test/harness/pg.ts's applySchema() already follows.
import { it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { RecordingMetricsSink } from "@governance-connector-framework/core";
import { PartitionMaintainer, type PartitionMaintainerConfig } from "../../src/ops/PartitionMaintainer.js";
import { OPS_METRICS as METRICS } from "../../src/ops/metrics.js";
import { applySchema, openPool, probePostgres, resetOperations, type PgPool } from "../harness/pg.js";
import { describeWithPg } from "../harness/describeWithPg.js";

const probe = await probePostgres();

describeWithPg(probe, "PartitionMaintainer", () => {
  let pool: PgPool;
  // Dates (YYYY-MM-DD strings from Postgres) of any partition a test created
  // outside the today/tomorrow range, dropped in afterEach so they can't
  // bleed into a later test's "days ahead" computation.
  let extraPartitionDays: string[] = [];

  beforeAll(async () => {
    pool = openPool(probe.url!);
    await applySchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await resetOperations(pool);
    extraPartitionDays = [];
  });

  afterEach(async () => {
    for (const day of extraPartitionDays) {
      await pool.query("SELECT drop_operations_partition($1::date)", [day])
          .catch(() => { /* may already be dropped by the test itself */ });
      // drop_operations_partition refuses if non-terminal rows remain; force
      // it for cleanup regardless of what a test left behind.
      const suffix = day.replaceAll("-", "");
      await pool.query(`DROP TABLE IF EXISTS operations_${suffix}`);
    }
    // Restore the baseline every other test in this file (and other files,
    // since fileParallelism is off but suites still share the database)
    // expects to find in place.
    await pool.query("SELECT create_operations_partition(current_date)");
    await pool.query("SELECT create_operations_partition(current_date + 1)");
  });

  async function dateOffset(days: number): Promise<string> {
    const { rows } = await pool.query<{ day: string }>(
        "SELECT to_char(current_date + $1::int, 'YYYY-MM-DD') AS day", [days]);
    return rows[0]!.day;
  }

  async function partitionExists(day: string): Promise<boolean> {
    const suffix = day.replaceAll("-", "");
    const { rows } = await pool.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present", [`operations_${suffix}`]);
    return rows[0]!.present;
  }

  function makeMaintainer(
      overrides: Partial<PartitionMaintainerConfig> = {},
  ): { maintainer: PartitionMaintainer; metrics: RecordingMetricsSink } {
    const metrics = new RecordingMetricsSink();
    const maintainer = new PartitionMaintainer(pool, {
      retentionDays: 1,
      metrics,
      logger: { warn: () => { /* quiet in tests */ }, error: () => { /* quiet in tests */ } },
      ...overrides,
    });
    return { maintainer, metrics };
  }

  it("ensures today's and tomorrow's partitions exist, recreating one that's missing", async () => {
    const tomorrow = await dateOffset(1);
    await pool.query(`DROP TABLE IF EXISTS operations_${tomorrow.replaceAll("-", "")}`);
    expect(await partitionExists(tomorrow)).toBe(false);

    const { maintainer } = makeMaintainer();
    await maintainer.runPass();

    expect(await partitionExists(await dateOffset(0))).toBe(true);
    expect(await partitionExists(tomorrow)).toBe(true);
  });

  it("a partition holding a PENDING row survives past-retention drop, loudly", async () => {
    const oldDay = await dateOffset(-5);
    extraPartitionDays.push(oldDay);
    await pool.query("SELECT create_operations_partition($1::date)", [oldDay]);
    await pool.query(
        `INSERT INTO operations
             (instance_id, object_class, op_type, lane_key, idempotency_key, name_attr_value, created_at)
         VALUES ('inst-old', '__ACCOUNT__', 'CREATE', 'create:__ACCOUNT__:x', 'idem-old-1', 'x',
                 $1::date + interval '1 hour')`,
        [oldDay],
    );

    const { maintainer, metrics } = makeMaintainer({ retentionDays: 1 });
    await maintainer.runPass();

    expect(await partitionExists(oldDay)).toBe(true);
    expect(metrics.totalOf(METRICS.PARTITION_DROP_REFUSED, { day: oldDay })).toBe(1);
  });

  it("drops a past-retention partition once every row in it is terminal", async () => {
    const oldDay = await dateOffset(-5);
    extraPartitionDays.push(oldDay);
    await pool.query("SELECT create_operations_partition($1::date)", [oldDay]);
    await pool.query(
        `INSERT INTO operations
             (instance_id, object_class, op_type, lane_key, idempotency_key, status, created_at)
         VALUES ('inst-old', '__ACCOUNT__', 'CREATE', 'create:__ACCOUNT__:y', 'idem-old-2', 'SUCCEEDED',
                 $1::date + interval '1 hour')`,
        [oldDay],
    );

    const { maintainer, metrics } = makeMaintainer({ retentionDays: 1 });
    await maintainer.runPass();

    expect(await partitionExists(oldDay)).toBe(false);
    expect(metrics.totalOf(METRICS.PARTITION_DROP_REFUSED)).toBe(0);
  });

  it("leaves a partition inside the retention window alone", async () => {
    const yesterday = await dateOffset(-1);
    // Not pushed to extraPartitionDays -- afterEach's create_operations_partition(current_date)
    // calls don't touch it, and it's expected to survive; the schema.sql
    // comment documents this exact case ("24 hour resolution window").
    await pool.query("SELECT create_operations_partition($1::date)", [yesterday]);
    extraPartitionDays.push(yesterday);

    const { maintainer } = makeMaintainer({ retentionDays: 1 });
    await maintainer.runPass();

    expect(await partitionExists(yesterday)).toBe(true);
  });

  it("two concurrent passes serialize under the blocking lock rather than erroring", async () => {
    const { maintainer: m1 } = makeMaintainer();
    const { maintainer: m2 } = makeMaintainer();

    await expect(Promise.all([m1.runPass(), m2.runPass()])).resolves.toBeDefined();

    expect(await partitionExists(await dateOffset(0))).toBe(true);
    expect(await partitionExists(await dateOffset(1))).toBe(true);
  });

  it("the days-ahead gauge reflects reality, including on a pass that changes nothing", async () => {
    const { maintainer, metrics } = makeMaintainer({ lookaheadDays: 1 });

    await maintainer.runPass();
    expect(metrics.latestGauge(METRICS.PARTITION_DAYS_AHEAD)).toBe(2); // today + tomorrow

    // Nothing to ensure or drop this time -- the gauge must still be
    // reported accurately, not skipped because the pass was otherwise a
    // no-op.
    await maintainer.runPass();
    expect(metrics.latestGauge(METRICS.PARTITION_DAYS_AHEAD)).toBe(2);
  });

  it("the days-ahead gauge stops counting at the first gap, not the total present", async () => {
    // A partition three days out with a gap at two days out: create today,
    // tomorrow, and +3, but not +2 -- "days ahead" must read 2, not 3.
    const dayPlus3 = await dateOffset(3);
    extraPartitionDays.push(dayPlus3);
    await pool.query("SELECT create_operations_partition($1::date)", [dayPlus3]);

    const { maintainer, metrics } = makeMaintainer({ lookaheadDays: 1, daysAheadProbeCap: 10 });
    await maintainer.runPass();

    expect(metrics.latestGauge(METRICS.PARTITION_DAYS_AHEAD)).toBe(2);
  });

  it("start()/stop() run passes on an interval and are each idempotent", async () => {
    const { maintainer, metrics } = makeMaintainer({ intervalMs: 30 });

    maintainer.start();
    maintainer.start(); // no-op: already have a timer

    await new Promise((resolve) => { setTimeout(resolve, 80); });

    // At least the immediate pass plus one interval tick should have run.
    expect(metrics.gauges.length).toBeGreaterThanOrEqual(2);

    await maintainer.stop();
    const countAfterStop = metrics.gauges.length;
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(metrics.gauges.length).toBe(countAfterStop); // no further passes fired

    await expect(maintainer.stop()).resolves.toBeUndefined(); // idempotent
  });
});
