# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Git rules

- All work happens on `feature/provisioning-service` or branches cut from it.
- Never check out, merge into, or push to `main`.
- Pull requests use base `feature/provisioning-service`, never base `main`.
- One plan phase per commit. Conventional commit messages.
- Design authority: `PROVISIONING_SERVICE_PLAN.md` in this repository and the
  checkpoint log in the framework repository
  (`governance-connector-framework_checkpoint_log.md`). Checkpoints are not
  duplicated here — the plan places CP-7 in the framework's log.
- Never patch framework code from this repository. File framework defects in
  the framework's `BUG_LOG.md`.

## What this repository is

The provisioning service: operation table, dispatcher, admission gate, HTTP
routes, wiring, and deployment. It consumes
`@governance-connector-framework/core` and adds the claim loop.

The boundary was locked at CP-5, and the split rule decides every borderline
symbol: **what the facade needs to execute one operation stays in the
framework; what only the claim loop needs lives here.**

Three repositories in the end state:

1. `governance-connector-framework` — connector execution only: SPI, loader,
   registry, manager, facade, infra. Knows nothing about provisioning
   operations.
2. `governance-provisioning-service` (here) — the queue and the schedule.
3. `external-connectors` — connector bundles, built against core's types.

## Current state

Phase P0 is complete: scaffold, config, and documents. **There is no
application code yet.** `src/index.ts` is a placeholder that exists so `tsc`
has an input; Phase P2 replaces it with the wiring module.

Phases P1 through P8 are described in `PROVISIONING_SERVICE_PLAN.md`. Read the
P0 findings section at the top of that file before starting any of them — six
discovery items had no answer at P0 and each blocks a specific phase. One has
since been answered: there is no metrics stack, and P6 was revised to suit.

## Commands

```bash
npm ci            # install
npm run build     # tsc -p tsconfig.json
npm run typecheck # tsc --noEmit
npm test          # vitest run  (passWithNoTests until P1)
npm run lint      # eslint .    (fatal, unlike the framework's `|| true`)
npm run clean     # rm -rf dist tsconfig.tsbuildinfo
```

Node 22 (`.nvmrc`). CI runs build, lint, and test on every pull request.

## TypeScript

`compilerOptions` are copied verbatim from the framework's
`packages/core/tsconfig.json` so that code typechecking there typechecks here.
That includes `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`,
both of which bite in practice:

- `Required<T>` does **not** strip an explicit `| undefined`. Write the
  resolved type out rather than deriving it.
- Every indexed access is `T | undefined`. Postgres row shapes need explicit
  narrowing at the boundary, not a cast that hides it.

## Conventions carried from the framework

- No new runtime dependencies without a reason recorded in the plan. P0
  installs none at all; `pg` and core arrive at P1, the HTTP framework at P4.
- Validation is hand-rolled and rejects unknown keys **by name** rather than
  ignoring them silently — a typo in a concurrency budget is otherwise
  indistinguishable from the default until production load makes it obvious.
- Comments explain why, not what.
