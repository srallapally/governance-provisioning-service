import tseslint from "typescript-eslint";

/**
 * The framework repo declares `eslint . || true` with no config file, which
 * makes linting a no-op there. This repo starts with a real config and a
 * fatal `lint` script instead -- cheaper to hold the line from commit one
 * than to retrofit it over a dispatcher.
 */
export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**", "coverage/**"],
    },
    ...tseslint.configs.recommended,
    {
        rules: {
            // The operation table's row shapes come back from pg as `any`;
            // P1 will need explicit casts at those boundaries rather than
            // silent propagation.
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
        },
    },
);
