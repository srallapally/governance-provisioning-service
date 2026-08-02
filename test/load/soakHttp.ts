// test/load/soakHttp.ts
//
// Phase P8's soak scenario: fake connectors, the REAL external loader, the
// REAL HTTP routes (including real bearer-JWT auth), and Postgres --
// `test/load/soak.ts` (left untouched) is still the right tool for fast
// local iteration (in-memory store, direct Dispatcher calls, no HTTP), but
// it doesn't exercise any of what P8 actually asks to be soaked: the
// assembled process, driven the way a real caller would drive it.
//
//   eval "$(bash scripts/test-pg.sh)" && npm run soak:http
//   OPS=5000 DATABASE_URL='postgres://...' npm run soak:http   # against a real instance
//
// What it checks, beyond what soak.ts already checks:
//   1. INDETERMINATE count -- zero expected; nothing here injects a fault.
//   2. The actual P1.5 property, not a percentile comparison. soak.ts's own
//      interactive-latency check is exactly the ordering-satisfiable one the
//      P8 plan text says not to rely on (`interactive p50 > batch p50`), and
//      docs/BUG_LOG.md documents why that's a blind spot: with instant
//      connectors there's rarely a batch attempt still in flight when an
//      interactive one gets claimed, reservation or not. Every instance
//      here runs with artificial per-attempt latency (LATENCY_MS) so
//      saturation is real and observable, and the pass condition is the
//      literal property the unit test asserts in miniature: at least one
//      interactive attempt actually STARTED while a batch attempt on the
//      same instance was still in flight, once batch concurrency reached
//      its cap.
//   3. Event-loop lag under load -- the dataset the CP-1 sidecar-vs-in-process
//      decision has been waiting on. Wired minimally here
//      (`startEventLoopLagMonitor`), not the rest of P6 (deferred to
//      Backlog) -- nothing here touches the production entrypoint.
//
// Lane-violation and per-attempt timing instrumentation lives in the fixture
// connector itself (`test/fixtures/connectors/fake/index.mjs`), not in this
// script: load is driven through the real loader, so this script never
// touches the connector instances it builds, unlike soak.ts's hand-wired
// connectors.
//
// A real Cloud SQL run caught a second, more subtle bug in this script (not
// in src/): the enqueue loop submitted ops one at a time, `await`ing each
// HTTP POST before starting the next. Against local Postgres that loop is
// fast enough not to matter, but against real Cloud SQL each POST costs a
// genuine round trip -- pacing submissions slowly enough that the dispatcher
// (claimIntervalMs=25ms, LATENCY_MS=400ms per attempt) usually finished an
// instance's previous op before the next one for that instance was even
// enqueued. That self-limited observed concurrency to 1 regardless of the
// configured budget, and it wasn't a false pass by accident: the fail
// condition only fires once `maxBatchConcurrency` reaches the budget, so a
// run that never generated enough concurrent load to approach the budget
// reports "OK" without ever having exercised the reservation. The same
// sequential loop also broke the latency numbers: `finishedAt` was only ever
// recorded by `pollUntilDrained`, which didn't start polling until the
// entire enqueue loop had finished, so an op enqueued early but finished
// early still reported a latency inflated by however long the rest of the
// enqueue loop took to run.
//
// Fixed by enqueueing with bounded concurrency (`ENQUEUE_CONCURRENCY`) and
// starting the poller concurrently with enqueueing rather than after it, so
// submissions actually arrive faster than the dispatcher can drain them and
// `finishedAt` reflects real completion time.
//
// That fix introduced a third bug, also only visible against real Cloud SQL:
// `OperationStore.enqueue()` holds one pool connection for its whole
// multi-round-trip transaction (BEGIN, advisory lock, dedup SELECT, INSERT,
// COMMIT), and that pool is the same one the dispatcher's claim/execute/
// finalize/reap traffic depends on (wiring.ts's own docstring says so).
// `dispatcherPoolMax` was sized only for the dispatcher's steady-state need
// (`INSTANCES * 2`), not for `ENQUEUE_CONCURRENCY` concurrent admissions on
// top of it -- against local Postgres a connection is held for microseconds
// so this never mattered, but against real Cloud SQL's round-trip latency,
// concurrent admissions alone could hold every connection in the pool for
// as long as backlog remained, starving the dispatcher entirely. A real run
// stalled at 4/100 ops terminal after the full timeout. Fixed by sizing the
// pool to comfortably exceed the offered admission concurrency, not just the
// dispatcher's own need.
import { performance } from "node:perf_hooks";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { METRICS, RecordingMetricsSink, startEventLoopLagMonitor } from "@governance-connector-framework/core";
import { start, stop, getStore, getManager, ensureApplication, type WiringConfig } from "../../src/provisioning/wiring.js";
import { createApp } from "../../src/http/app.js";
import { openPool, type PgPool } from "../harness/pg.js";

const TOTAL_OPS = Number(process.env["OPS"] ?? 1_000);
const INSTANCES = Number(process.env["INSTANCES"] ?? 4);
const MUTATION_BUDGET = Number(process.env["BUDGET"] ?? 10);
const INTERACTIVE_SHARE = Number(process.env["INTERACTIVE_SHARE"] ?? 0.05);
const LATENCY_MS = Number(process.env["LATENCY_MS"] ?? 400);
const TIMEOUT_MS = Number(process.env["SOAK_TIMEOUT_MS"] ?? 180_000);
const LAG_SAMPLE_INTERVAL_MS = 2_000;
// How many enqueue POSTs run in parallel. Needs to comfortably outrun the
// dispatcher's own per-attempt time (LATENCY_MS plus real round trips) or
// concurrency never builds up regardless of the configured budget -- see
// the header comment. Default comfortably above dispatcherPoolMax so the
// shared pool, not this loop, is what paces admission under real latency.
const ENQUEUE_CONCURRENCY = Number(process.env["ENQUEUE_CONCURRENCY"] ?? 20);

const OBJECT_CLASS = "__ACCOUNT__";
const instanceIds = Array.from({ length: INSTANCES }, (_, i) => `soak-http-${i}`);
const FIXTURE_CONNECTORS = path.join(import.meta.dirname, "..", "fixtures", "connectors");

interface Sample { enqueuedAt: number; finishedAt?: number; priority: string }

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("soak:http requires DATABASE_URL (run scripts/test-pg.sh, or point at a real instance)");
  }

  // ---- real local JWKS server + a real signed token ----------------------
  // Exercises the real requireJwt() middleware, not a pass-through fake --
  // same pattern as test/http/auth.test.ts.
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "soak-key", alg: "RS256", use: "sig" });
  const jwksServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  const jwksAddress = jwksServer.address();
  if (jwksAddress === null || typeof jwksAddress === "string") throw new Error("expected a bound TCP address");

  const ISS = "https://127.0.0.1:443";
  const AUD = "provisioning-service-soak";
  process.env["JWT_JWKS_URI"] = `http://127.0.0.1:${jwksAddress.port}/jwks.json`;
  process.env["JWT_EXPECTED_ISS"] = ISS;
  process.env["JWT_EXPECTED_AUD"] = AUD;

  const token = await new SignJWT({ scope: "" })
      .setProtectedHeader({ alg: "RS256", kid: "soak-key" })
      .setSubject("soak")
      .setIssuer(ISS)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  // auth.ts validates JWT_* and builds its JWKS client at import time, so it
  // must be imported dynamically, after the env vars above are set.
  const { requireJwt } = await import("../../src/http/auth.js");
  // Kept as a namespace object, not destructured: `laneViolations` is a
  // reassigned `let` export (a live ESM binding), and destructuring it here
  // would copy its value at import time rather than track updates made while
  // the run proceeds. `attemptLog` is fine to destructure -- it's a stable
  // array reference this script only ever reads, never reassigns.
  const fixtureModule = await import("../fixtures/connectors/fake/index.mjs");
  const { attemptLog } = fixtureModule;
  fixtureModule.resetSoakInstrumentation();

  // ---- one ApplicationConfig per instance, on disk ------------------------
  const appConfigDir = await mkdtemp(path.join(tmpdir(), "soak-http-appcfg-"));
  for (const instanceId of instanceIds) {
    await writeFile(
        path.join(appConfigDir, `${instanceId}.json`),
        JSON.stringify({
          applicationId: instanceId,
          connectorType: "fake",
          connectorVersion: "1.0.0",
          // soakInstrumented turns on the fixture's attempt-timing/lane-violation
          // recording; latencyMs is what makes saturation real and observable
          // (see the header comment on why instant connectors can't discriminate
          // the P1.5 property).
          connectorConfig: { soakInstrumented: true, latencyMs: LATENCY_MS },
          runtime: {
            mutationConcurrency: MUTATION_BUDGET,
            readConcurrency: MUTATION_BUDGET,
            attemptDeadlineMs: Math.max(5_000, LATENCY_MS * 4),
            interactiveSliceFraction: 0.2,
          },
        }, null, 2),
    );
  }

  // ---- the real stack ------------------------------------------------------
  const config: WiringConfig = {
    databaseUrl,
    connectorBundleDir: FIXTURE_CONNECTORS,
    appConfigStore: "file",
    appConfigDir,
    drainBudgetMs: 8_000,
    shutdownGraceMs: 2_000,
    statementTimeoutMs: 5_000,
    partitionRetentionDays: 1,
    partitionMaintenanceIntervalMs: 3_600_000,
    // Shared by HTTP admission (OperationStore.enqueue()) and the dispatcher's
    // claim/execute/finalize/reap traffic alike -- one pool, per wiring.ts's
    // own docstring. enqueue() holds a single connection for its whole
    // multi-round-trip transaction (BEGIN, advisory lock, dedup SELECT,
    // INSERT, COMMIT), not just for one query, so ENQUEUE_CONCURRENCY
    // concurrent admissions can hold up to that many connections for the
    // entire submission phase. Sizing this at just INSTANCES*2 (enough for
    // local Postgres, where each round trip is sub-millisecond so a
    // connection is barely ever actually contended) let ENQUEUE_CONCURRENCY
    // concurrent admissions saturate the whole pool under real Cloud SQL
    // latency, starving the dispatcher of any connection to claim or finalize
    // anything -- a real run stalled at 4/100 ops terminal after the full
    // timeout. Must comfortably exceed the offered admission concurrency, not
    // just the dispatcher's own steady-state need.
    dispatcherPoolMax: Math.max(20, ENQUEUE_CONCURRENCY + INSTANCES * 2),
    claimIntervalMs: 25,
    reaperThresholdMs: 10 * 60_000,
    logger: { warn: (m) => console.warn(m), error: (m) => console.error(m) },
  };

  await start(config);
  for (const instanceId of instanceIds) await ensureApplication(instanceId);

  const lagSink = new RecordingMetricsSink();
  const lagMonitor = await startEventLoopLagMonitor(lagSink, LAG_SAMPLE_INTERVAL_MS);

  const app = createApp({
    store: getStore(),
    manager: getManager(),
    ensureApplication,
    authMiddleware: requireJwt(),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const httpAddress = server.address();
  if (httpAddress === null || typeof httpAddress === "string") throw new Error("expected a bound TCP address");
  const base = `http://127.0.0.1:${httpAddress.port}`;

  console.log(
      `soak:http ${TOTAL_OPS} ops across ${INSTANCES} instances, budget ${MUTATION_BUDGET}/instance, ` +
      `connector latency ${LATENCY_MS}ms`);

  // ---- enqueue via real HTTP POST ------------------------------------------
  const samples = new Map<string, Sample>();
  // Names, and therefore lanes, must be allocated independently per instance
  // -- not `i % nameSpace` against a single pool shared across every
  // instance's round-robin stream. Lane exclusion is scoped per
  // (instanceId, laneKey), so reusing a name across different instances is
  // harmless, but if nameSpace and INSTANCES share a common factor, `i %
  // INSTANCES` (instance assignment) and `i % nameSpace` (name assignment)
  // interact: an instance only ever sees `nameSpace / gcd(nameSpace,
  // INSTANCES)` distinct names in its own stream, not `nameSpace`. At
  // OPS=1000 (nameSpace=125, INSTANCES=4, gcd=1) this never surfaced; at
  // OPS=100 (nameSpace=12, gcd=4) it collapsed each instance to 3 distinct
  // lanes, capping observable concurrency regardless of the configured
  // budget -- found via a real run against Cloud SQL, not caught locally.
  // `indexWithinInstance` increases by exactly 1 for consecutive ops on the
  // same instance, so cycling it through `perInstanceNameSpace` names is
  // immune to this regardless of how TOTAL_OPS/INSTANCES relate.
  const opsPerInstance = Math.ceil(TOTAL_OPS / INSTANCES);
  const perInstanceNameSpace = Math.max(1, Math.floor(opsPerInstance / 8));

  // ---- drain: poll a second, direct pool, not HTTP -------------------------
  // At this scale, polling GET /operations/:id per row would mostly measure
  // HTTP round-trip overhead rather than scheduling behavior -- the same
  // separation soak.ts's own verifyPool-style pattern already established.
  //
  // Started concurrently with enqueueing, not after: `finishedAt` needs to
  // reflect real completion time, and under real network latency the
  // enqueue loop itself can take long enough that "start polling once
  // enqueueing is done" would inflate every latency sample by however long
  // the rest of the enqueue loop took. `expectedTotal` is known up front
  // (TOTAL_OPS), so the poller doesn't need the full id set before it can
  // start checking whatever ids have shown up in `samples` so far.
  const pollPool: PgPool = openPool(databaseUrl, 4);
  const enqueueStart = performance.now();
  const pollPromise = pollUntilDrained(pollPool, samples, TOTAL_OPS, TIMEOUT_MS);

  // Bounded-concurrency submission, not one `await fetch()` at a time: under
  // real network latency, a sequential loop paces submissions slowly enough
  // that the dispatcher usually finishes an instance's previous op before
  // the next one for that instance is even enqueued, self-limiting observed
  // concurrency to ~1 regardless of the configured budget -- see the header
  // comment.
  let nextIndex = 0;
  async function enqueueWorker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= TOTAL_OPS) return;

      const instanceId = instanceIds[i % INSTANCES]!;
      const priority = i % Math.round(1 / INTERACTIVE_SHARE) === 0 ? "interactive" : "batch";
      const indexWithinInstance = Math.floor(i / INSTANCES);
      const name = `user-${indexWithinInstance % perInstanceNameSpace}`;

      const res = await fetch(`${base}/instances/${instanceId}/objects/${OBJECT_CLASS}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        // __priority isn't a real connector attribute; it's how the fixture correlates
        // a recorded attempt back to the priority class that enqueued it, since
        // the connector SPI has no concept of priority.
        body: JSON.stringify({ attributes: { __NAME__: name, __priority: priority }, priority }),
      });
      if (res.status !== 202) {
        throw new Error(`enqueue failed: ${res.status} ${await res.text()}`);
      }
      const body = await res.json() as { operationId: string };
      samples.set(body.operationId, { enqueuedAt: performance.now(), priority });
    }
  }

  await Promise.all(Array.from({ length: ENQUEUE_CONCURRENCY }, () => enqueueWorker()));

  const enqueueMs = performance.now() - enqueueStart;
  console.log(`enqueue: ${TOTAL_OPS} ops (concurrency ${ENQUEUE_CONCURRENCY}) in ${enqueueMs.toFixed(0)}ms (${rate(TOTAL_OPS, enqueueMs)}/s)`);

  const drainStart = performance.now();
  const finishedCount = await pollPromise;
  const drainMs = performance.now() - drainStart;

  const outcomeRows = await pollPool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM operations WHERE id = ANY($1::uuid[]) GROUP BY status`,
      [[...samples.keys()]],
  );
  const indeterminate = outcomeRows.rows.find((r) => r.status === "INDETERMINATE")?.n ?? 0;
  const outcomeSummary = outcomeRows.rows.map((r) => `${r.status}=${r.n}`).join(", ");

  // ---- report ---------------------------------------------------------------
  const finished = [...samples.values()].filter((s) => s.finishedAt !== undefined);
  const latencies = (p: string) => finished
      .filter((s) => s.priority === p)
      .map((s) => s.finishedAt! - s.enqueuedAt)
      .sort((a, b) => a - b);

  const batch = latencies("batch");
  const interactive = latencies("interactive");

  // Polling started concurrently with enqueueing (see above), so this is not
  // "time to process finishedCount ops" -- most of them likely finished
  // while enqueueing was still in progress. It's the tail: how much longer
  // the poller had to wait, after the last op was submitted, before every op
  // reached a terminal state.
  console.log(`drain tail: ${finishedCount}/${TOTAL_OPS} ops terminal, ${drainMs.toFixed(0)}ms after the last enqueue`);
  console.log(`batch       latency p50 ${pct(batch, 50)}ms  p99 ${pct(batch, 99)}ms  n=${batch.length}`);
  console.log(`interactive latency p50 ${pct(interactive, 50)}ms  p99 ${pct(interactive, 99)}ms  n=${interactive.length}`);
  // FAILED_CONFIRMED is expected and not a failure signal here: names are
  // deliberately reused within each instance's own small name space (see
  // perInstanceNameSpace above) so lanes genuinely collide, same as
  // soak.ts -- most creates on an already-taken name correctly fail
  // ALREADY_EXISTS against the real target. Only INDETERMINATE, checked
  // separately, indicates something actually wrong.
  console.log(`outcomes: ${outcomeSummary} (FAILED_CONFIRMED is expected -- deliberate name collisions)`);

  const { concurrentStarts, maxBatchConcurrency } = analyzeAttempts(attemptLog);
  const laneViolations = fixtureModule.laneViolations;
  console.log(`lane serialization violations: ${laneViolations}`);
  console.log(`batch concurrency reached: ${maxBatchConcurrency} (budget ${MUTATION_BUDGET})`);
  console.log(
      `interactive attempts that started while a batch attempt was in flight: ${concurrentStarts} ` +
      `(the actual P1.5 property, not a latency comparison)`);

  lagMonitor.sample();
  lagMonitor.stop();
  const meanLag = lagSink.gauges.filter((g) => g.name === METRICS.EVENT_LOOP_LAG_MS && g.labels["quantile"] === "mean").map((g) => g.value);
  const p99Lag = lagSink.gauges.filter((g) => g.name === METRICS.EVENT_LOOP_LAG_MS && g.labels["quantile"] === "p99").map((g) => g.value);
  console.log(
      `event-loop lag (${meanLag.length} windows, ${LAG_SAMPLE_INTERVAL_MS}ms each): ` +
      `mean ${fmtStats(meanLag)}ms, p99 ${fmtStats(p99Lag)}ms`);

  // ---- teardown ---------------------------------------------------------------
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pollPool.end();
  await stop();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  await rm(appConfigDir, { recursive: true, force: true });

  const failures: string[] = [];
  if (finishedCount !== TOTAL_OPS) {
    failures.push(`only ${finishedCount}/${TOTAL_OPS} operations reached a terminal state`);
  }
  if (laneViolations > 0) {
    failures.push(`${laneViolations} lane violation(s): two operations on one lane overlapped`);
  }
  if (indeterminate > 0) {
    failures.push(`${indeterminate} INDETERMINATE outcome(s) with no faults injected`);
  }
  if (interactive.length > 0 && maxBatchConcurrency >= MUTATION_BUDGET - 1 && concurrentStarts === 0) {
    failures.push(
        "batch reached saturation but no interactive attempt ever started while a batch " +
        "attempt was still in flight -- the reserved slice is not doing its job");
  }

  if (failures.length > 0) {
    console.error("\nFAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nOK");
}

/**
 * Poll ids until `expectedTotal` of them reach a terminal status or the
 * timeout elapses. Direct-DB, not HTTP -- see the header comment.
 *
 * Runs concurrently with enqueueing, not after it: `samples` grows while
 * this loop runs, so each iteration re-reads its current keys rather than
 * snapshotting them once. `expectedTotal` (TOTAL_OPS) is known up front, so
 * the poller doesn't need every id to exist yet to make progress on the ids
 * it already has.
 */
async function pollUntilDrained(
    pool: PgPool,
    samples: Map<string, Sample>,
    expectedTotal: number,
    timeoutMs: number,
): Promise<number> {
  const seen = new Set<string>();
  const deadline = Date.now() + timeoutMs;

  while (seen.size < expectedTotal && Date.now() < deadline) {
    const ids = [...samples.keys()];
    if (ids.length > 0) {
      const { rows } = await pool.query<{ id: string; status: string }>(
          `SELECT id, status FROM operations WHERE id = ANY($1::uuid[])`,
          [ids],
      );
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        if (row.status === "PENDING" || row.status === "RUNNING" || row.status === "AWAITING_READBACK") continue;
        seen.add(row.id);
        const s = samples.get(row.id);
        if (s) s.finishedAt = performance.now();
      }
    }
    if (seen.size < expectedTotal) await new Promise((r) => setTimeout(r, 50));
  }
  return seen.size;
}

/**
 * The actual P1.5 property: did any interactive attempt start while a batch
 * attempt on the same instance was still in flight? Computed from recorded
 * `{ priority, instanceId, start, end }` attempts, not from latency
 * percentiles -- see the header comment for why a percentile comparison
 * can't discriminate this.
 */
function analyzeAttempts(
    attemptLog: Array<{ priority: string; instanceId: string; start: number; end?: number }>,
): { concurrentStarts: number; maxBatchConcurrency: number } {
  const byInstance = new Map<string, {
    batch: Array<{ start: number; end: number }>;
    interactive: Array<{ start: number }>;
  }>();

  for (const entry of attemptLog) {
    if (entry.end === undefined) continue; // still in flight (shouldn't happen once drained)
    const bucket = byInstance.get(entry.instanceId) ?? { batch: [], interactive: [] };
    if (entry.priority === "batch") bucket.batch.push({ start: entry.start, end: entry.end });
    else if (entry.priority === "interactive") bucket.interactive.push({ start: entry.start });
    byInstance.set(entry.instanceId, bucket);
  }

  let concurrentStarts = 0;
  let maxBatchConcurrency = 0;

  for (const bucket of byInstance.values()) {
    for (const i of bucket.interactive) {
      if (bucket.batch.some((b) => b.start <= i.start && i.start < b.end)) concurrentStarts++;
    }

    const events: Array<[number, 1 | -1]> = [];
    for (const b of bucket.batch) { events.push([b.start, 1]); events.push([b.end, -1]); }
    events.sort((a, b) => a[0] - b[0]);
    let running = 0;
    let max = 0;
    for (const [, delta] of events) { running += delta; max = Math.max(max, running); }
    maxBatchConcurrency = Math.max(maxBatchConcurrency, max);
  }

  // laneViolations is a live ESM binding from the fixture module, read by the
  // caller directly (fixtureModule.laneViolations) -- not threaded through
  // here, since it isn't derived from attemptLog.
  return { concurrentStarts, maxBatchConcurrency };
}

const rate = (n: number, ms: number) => (ms > 0 ? Math.round(n / (ms / 1000)).toLocaleString() : "inf");
const pctRaw = (sorted: number[], p: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))]!;
const pct = (sorted: number[], p: number) => pctRaw(sorted, p).toFixed(1);
const fmtStats = (values: number[]): string => {
  if (values.length === 0) return "n/a";
  const sorted = [...values].sort((a, b) => a - b);
  return `min ${sorted[0]!.toFixed(1)} / p50 ${pct(sorted, 50)} / max ${sorted[sorted.length - 1]!.toFixed(1)}`;
};

main().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
