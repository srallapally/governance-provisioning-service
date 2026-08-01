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
    },
});
