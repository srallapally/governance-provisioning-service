import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // P0 ships no code and therefore no tests. Without this the scaffold's
        // `npm test` would fail on "no test files found", which would make CI
        // red for a reason that is not a defect. P1 brings the contract suite
        // and this stops being load-bearing.
        passWithNoTests: true,
        include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    },
});
