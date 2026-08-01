// test/load/soak.ts
//
// Manual load script. NOT a vitest suite -- it is slow by design and asserts
// throughput, which is exactly the kind of thing that flakes in CI.
//
//   npx tsx test/load/soak.ts                # in-memory store, default 50k ops
//   OPS=200000 npx tsx test/load/soak.ts     # heavier run
//   eval "$(bash ../../scripts/test-pg.sh)" && STORE=pg npx tsx test/load/soak.ts
//
// What it checks:
//   1. drain rate               -- operations per second, end to end
//   2. per-lane serialization   -- two operations on one lane never overlap
//   3. interactive latency      -- p50/p99 for interactive work while a large
//                                  batch backlog is draining
//
// The drain runs the real Dispatcher against real FakeConnectors, so what is
// measured is the shipping scheduler: its claim cycle, lane exclusion,
// per-instance budgets, and priority ordering.

// ---------------------------------------------------------------------------
// REPRODUCED HERE — 2026-08-01, Phase P1 (provisioning service)
// ---------------------------------------------------------------------------
// Same sandbox, same shape, now running against the extracted code in this
// repository with core consumed as a package rather than as a sibling
// workspace.
//
//   store   ops     enqueue      drain        batch p50   interactive p50   lanes
//   memory  50000   296,226/s    2,636/s      12,775 ms   825 ms            0
//   memory   5000   295,162/s   15,868/s         227 ms    66 ms            0
//   pg16     5000       492/s    1,031/s       8,077 ms   5,646 ms          0
//
// Against the Phase 11 baseline below: memory 50k drain within 1%, memory 5k
// within 11%, pg 5k within 12%. Zero lane violations in all three, which is
// the assertion that actually matters -- the throughput figures are sandbox
// weather, but a lane violation would be a correctness defect.
//
// The interactive/batch separation persists (825ms against 12,775ms at 50k),
// and is still produced by the claim query's ORDER BY rather than by any
// reservation. BUG-4 remains open; P1.5 is what makes the slice real, and the
// discriminating test there is deliberately not a latency comparison, because
// this ordering effect satisfies one on its own.
//
// ---------------------------------------------------------------------------
// LAST MEASURED BASELINE — 2026-08-01, Phase 11 (framework, pre-extraction)
// ---------------------------------------------------------------------------
// Node v22.22.2, 4 vCPU sandbox, 4 instances, mutation budget 10 each,
// ~2% interactive, claim batch 100.
//
//   store   ops     enqueue      drain        batch p50   interactive p50   lanes
//   memory  50000   349,006/s    2,653/s      12,388 ms   781 ms            0
//   memory   5000   ~350,000/s  17,758/s         n/a      n/a               0
//   pg16     5000       546/s    1,168/s       7,064 ms   4,782 ms          0
//
// Read these with two caveats.
//
// 1. The in-memory drain rate falls with backlog size -- 17,758/s at 5k
//    against 2,653/s at 50k -- because MemoryOperationStore.claimBatch scans
//    every row each cycle to build the blocked-lane set and the candidate
//    list. That is O(n) per cycle by construction and is a property of the
//    test double, not of the dispatcher. The Postgres store answers the same
//    question from a partial index. Do not quote the memory numbers as a
//    framework throughput ceiling.
//
// 2. Latency is measured from enqueue, and the drain does not start until
//    every operation has been enqueued. Where enqueue is slow relative to
//    drain -- the Postgres run, at 9.1 s to enqueue 5k -- every percentile
//    absorbs that head start, which compresses the gap between the priority
//    classes. The interactive-versus-batch separation should be read from a
//    run whose enqueue phase is negligible: at 50k in memory it is 781 ms
//    against 12,388 ms, a factor of ~16 under a full batch flood.
//
// Lane serialization violations were zero in every run, on both stores. That
// assertion is unaffected by either caveat: it comes from the connector call
// logs, not from timing.
// ---------------------------------------------------------------------------

import { performance } from "node:perf_hooks";
import { MemoryOperationStore } from "../harness/MemoryOperationStore.js";
import { OperationStore, type OperationStoreApi } from "../../src/ops/OperationStore.js";
import { Dispatcher } from "../../src/ops/Dispatcher.js";
import { ConnectorRegistry } from "@governance-connector-framework/core";
import { ConnectorManager } from "@governance-connector-framework/core";
import { makeFakeConnector } from "@governance-connector-framework/core/testing";

const TOTAL_OPS = Number(process.env["OPS"] ?? 50_000);
const INSTANCES = Number(process.env["INSTANCES"] ?? 4);
const MUTATION_BUDGET = Number(process.env["BUDGET"] ?? 10);
const INTERACTIVE_SHARE = Number(process.env["INTERACTIVE_SHARE"] ?? 0.02);
const CLAIM_LIMIT = Number(process.env["CLAIM_LIMIT"] ?? 100);
const TIMEOUT_MS = Number(process.env["SOAK_TIMEOUT_MS"] ?? 180_000);
const USE_PG = process.env["STORE"] === "pg";

const OBJECT_CLASS = "__ACCOUNT__";
const instanceIds = Array.from({ length: INSTANCES }, (_, i) => `inst-${i}`);

interface Sample { enqueuedAt: number; finishedAt?: number; priority: string }

/** Concurrent calls per lane, so any overlap is visible. */
let laneViolations = 0;

async function main(): Promise<void> {
  const { store, teardown } = await openStore();
  const registry = new ConnectorRegistry();
  const inLane = new Map<string, number>();

  for (const instanceId of instanceIds) {
    const connector = makeFakeConnector();
    const realCreate = connector.create!.bind(connector);

    // Wrap create to watch the lane the dispatcher is supposed to be holding.
    (connector as any).create = async (oc: string, attrs: any, options?: any) => {
      const lane = `${instanceId}:${attrs?.__NAME__}`;
      const depth = (inLane.get(lane) ?? 0) + 1;
      inLane.set(lane, depth);
      if (depth > 1) laneViolations++;
      try {
        return await realCreate(oc, attrs, options);
      } finally {
        inLane.set(lane, (inLane.get(lane) ?? 1) - 1);
      }
    };

    registry.registerFactory(instanceId, "1.0.0", async () => connector);
    registry.registerCapabilities(instanceId, "1.0.0", { equalitySearchOnName: true });
    registry.registerInstance(instanceId, instanceId, "1.0.0", {}, {
      mutationConcurrency: MUTATION_BUDGET,
      readConcurrency: MUTATION_BUDGET,
    });
  }

  const manager = new ConnectorManager(registry, { logger: { error: () => {} } });

  console.log(`soak: ${TOTAL_OPS} ops across ${INSTANCES} instances, ` +
      `budget ${MUTATION_BUDGET}/instance, store=${USE_PG ? "postgres" : "memory"}`);

  // ---- enqueue -----------------------------------------------------------
  const samples = new Map<string, Sample>();
  const enqueueStart = performance.now();
  // A deliberately small name space so lanes genuinely collide and the
  // serialization guarantee is under real pressure.
  const nameSpace = Math.max(1, Math.floor(TOTAL_OPS / 8));

  for (let i = 0; i < TOTAL_OPS; i++) {
    const instanceId = instanceIds[i % INSTANCES]!;
    const priority = i % Math.round(1 / INTERACTIVE_SHARE) === 0 ? "interactive" : "batch";
    const name = `user-${i % nameSpace}`;

    const { id } = await store.enqueue({
      instanceId,
      objectClass: OBJECT_CLASS,
      opType: "CREATE",
      laneKey: `create:${OBJECT_CLASS}:${name}`,
      idempotencyKey: `soak-${i}`,
      nameAttrValue: name,
      attrs: { __NAME__: name },
      priority: priority as "interactive" | "batch",
    });
    samples.set(id, { enqueuedAt: performance.now(), priority });
  }

  const enqueueMs = performance.now() - enqueueStart;
  console.log(`enqueue: ${TOTAL_OPS} ops in ${enqueueMs.toFixed(0)}ms (${rate(TOTAL_OPS, enqueueMs)}/s)`);

  // ---- drain -------------------------------------------------------------
  const drainStart = performance.now();
  const finishedCount = await drain(store, registry, manager, samples);
  const drainMs = performance.now() - drainStart;

  // ---- report ------------------------------------------------------------
  const finished = [...samples.values()].filter(s => s.finishedAt !== undefined);
  const latencies = (p: string) => finished
      .filter(s => s.priority === p)
      .map(s => s.finishedAt! - s.enqueuedAt)
      .sort((a, b) => a - b);

  const batch = latencies("batch");
  const interactive = latencies("interactive");

  console.log(`drain:   ${finishedCount} ops in ${drainMs.toFixed(0)}ms (${rate(finishedCount, drainMs)}/s)`);
  console.log(`batch       latency p50 ${pct(batch, 50)}ms  p99 ${pct(batch, 99)}ms  n=${batch.length}`);
  console.log(`interactive latency p50 ${pct(interactive, 50)}ms  p99 ${pct(interactive, 99)}ms  n=${interactive.length}`);
  console.log(`lane serialization violations: ${laneViolations}`);

  const failures: string[] = [];
  if (finishedCount !== TOTAL_OPS) {
    failures.push(`only ${finishedCount}/${TOTAL_OPS} operations reached a terminal state`);
  }
  if (laneViolations > 0) {
    failures.push(`${laneViolations} lane violation(s): two operations on one lane overlapped`);
  }
  if (interactive.length > 0 && batch.length > 0 && pctRaw(interactive, 50) > pctRaw(batch, 50)) {
    failures.push("interactive p50 exceeded batch p50 -- the reserved slice is not doing its job");
  }

  await manager.shutdown();
  await teardown();

  if (failures.length > 0) {
    console.error("\nFAIL");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nOK");
}

/**
 * Drive the real Dispatcher until the backlog is empty.
 *
 * Completion is observed by polling the store rather than by instrumenting the
 * dispatcher, so what is timed is what a caller polling the status endpoint
 * would actually see.
 */
async function drain(
    store: OperationStoreApi,
    registry: ConnectorRegistry,
    manager: ConnectorManager,
    samples: Map<string, Sample>,
): Promise<number> {
  const dispatcher = new Dispatcher({
    store,
    manager,
    registry,
    config: { claimBatchSize: CLAIM_LIMIT, logger: { error: () => {} } },
  });

  const total = samples.size;
  const seen = new Set<string>();
  const deadline = Date.now() + TIMEOUT_MS;

  while (seen.size < total && Date.now() < deadline) {
    await dispatcher.runCycle();
    await new Promise(r => setTimeout(r, 1));

    for (const row of rowsOf(store)) {
      if (seen.has(row.id)) continue;
      if (row.status === "PENDING" || row.status === "RUNNING") continue;
      seen.add(row.id);
      const s = samples.get(row.id);
      if (s) s.finishedAt = performance.now();
    }
  }

  await dispatcher.stop();
  return seen.size;
}

/** Terminal-state polling differs by store; both expose enough to observe it. */
function rowsOf(store: OperationStoreApi): Array<{ id: string; status: string }> {
  if (store instanceof MemoryOperationStore) {
    return store.allRows().map(r => ({ id: r.id, status: r.status }));
  }
  // The Postgres path polls in openStore's wrapper instead; see pollPg below.
  return pgSnapshot;
}

/** Latest snapshot for the Postgres path, refreshed by its poller. */
let pgSnapshot: Array<{ id: string; status: string }> = [];

async function openStore(): Promise<{ store: OperationStoreApi; teardown: () => Promise<void> }> {
  if (!USE_PG) {
    return { store: new MemoryOperationStore(), teardown: async () => {} };
  }

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("STORE=pg requires DATABASE_URL (run scripts/test-pg.sh)");

  const { openPool, applySchema, resetOperations } = await import("../harness/pg.js");
  const pool = openPool(url, 16);
  await applySchema(pool);
  await resetOperations(pool);

  const poller = setInterval(() => {
    void pool.query("SELECT id, status FROM operations")
        .then(r => { pgSnapshot = r.rows as Array<{ id: string; status: string }>; })
        .catch(() => { /* transient; the next tick retries */ });
  }, 50);
  poller.unref?.();

  return {
    store: new OperationStore(pool),
    teardown: async () => { clearInterval(poller); await pool.end(); },
  };
}

const rate = (n: number, ms: number) => ms > 0 ? Math.round(n / (ms / 1000)).toLocaleString() : "inf";
const pctRaw = (sorted: number[], p: number) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))]!;
const pct = (sorted: number[], p: number) => pctRaw(sorted, p).toFixed(1);

main().catch(e => { console.error(e); process.exitCode = 1; });
