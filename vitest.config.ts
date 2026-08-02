import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // P0 ships no code and therefore no tests. Without this the scaffold's
        // `npm test` would fail on "no test files found", which would make CI
        // red for a reason that is not a defect. P1 brings the contract suite
        // and this stops being load-bearing.
        passWithNoTests: true,
        include: ["test/**/*.test.ts", "src/**/*.test.ts"],
        // Vitest's default is to run test files in parallel worker threads.
        // That is fine for suites that are each self-contained, but more than
        // one file here (test/contract/operation-store.pg.test.ts,
        // test/provisioning/wiring.test.ts) exercises the SAME real Postgres
        // instance's `operations` table via `resetOperations()`, which
        // truncates it. Two such files running concurrently can wipe rows out
        // from under each other mid-test -- a failure that looks like a
        // dispatcher defect ("operation was never claimed") and is actually a
        // test-isolation gap. The in-memory suites have no such shared state
        // and cost nothing to serialize alongside them; the whole suite still
        // runs in a few seconds.
        fileParallelism: false,
        // `describeWithPg` (test/harness/describeWithPg.ts) already raises the
        // per-test default above vitest's 5000ms for real-network latency
        // (P3). Hooks are a separate vitest knob (hookTimeout) that P3 didn't
        // touch, and P4's route suites found it matters too: `stop()`'s drain
        // is deliberately bounded, not cancelling (see wiring.ts), so a test's
        // last operation can still have a query genuinely in flight against
        // the shared pool when `afterEach`'s stop() returns and the next
        // test's `beforeEach` immediately TRUNCATEs -- TRUNCATE needs ACCESS
        // EXCLUSIVE and blocks behind it. Observed directly: a repeat run of
        // `npm test` against real Postgres hit the 10s default here, not from
        // a hung test, from exactly this ordering. Same fix shape as P3's
        // testTimeout bump, applied to the other timeout that governs it.
        hookTimeout: 20_000,
    },
});
