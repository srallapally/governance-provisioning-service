# governance-provisioning-service

Async provisioning over the [governance connector framework][fw]. This service
owns the claim loop: the durable operation table, the dispatcher that decides
what to run and when, the admission gate, and the HTTP surface that answers
202 with an operationId.

The framework owns the other half — executing one connector operation
correctly, with attempt deadlines, abort propagation, circuit breakers, and
connection pooling. The boundary was locked at CP-5 under a single rule: what
the facade needs to execute one operation stays there; what only the claim
loop needs lives here.

## Capabilities

- **Async mutations over HTTP.** `POST` a create/update/delete/add-values/
  remove-values, get `202` with an `operationId` back immediately; poll
  `GET /operations/:id` for the outcome. The mutation is durably queued
  (Postgres) before the caller gets a response — a crash right after `202`
  loses nothing.
- **A durable, horizontally-scalable claim loop**, not an in-memory queue.
  Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`; the reaper and partition
  maintainer use advisory locks. Multiple replicas of this service can run
  against the same Postgres with no leader election and no risk of double
  claiming — see `docs/DEPLOYMENT_PLAN.md` for why that's true by
  construction, not by convention.
- **Priority scheduling that actually reserves capacity.** Batch work is
  capped below an instance's full mutation budget; interactive work can use
  the whole thing. A batch backlog can never starve an interactive request
  of the reserved slice.
- **Lane serialization.** Two operations that touch the same object
  (`create:<objectClass>:<nameAttrValue>`, or `uid:<objectClass>:<uid>` for
  update/delete/deltas) can never run concurrently, across every replica —
  the lock lives in Postgres, not in any one process's memory.
- **A terminal outcome taxonomy that tells the caller what to do next**, not
  just pass/fail — see the outcome table in Design, below.
- **Connector-agnostic.** Executes through any OpenICF-compatible connector
  bundle the framework loads at runtime (`CONNECTOR_BUNDLE_DIR`) — this
  service never talks to a target system directly.
- **Lazy application registration.** An application/instance becomes known
  the first time an operation names it; nothing needs registering at boot.
- **Bearer-JWT authenticated**, with two boot-time cross-validation checks
  (issuer/JWKS same host — refuses to boot on mismatch; inbound audience vs.
  outbound client id collapse — warns) that catch copy-paste config mistakes
  before they become a security question at request time.
- **Container-orchestrator-ready.** `/healthz`/`/readyz` liveness and
  readiness probes, graceful `SIGTERM`/`SIGINT` draining, a production-shaped
  Docker image, and a documented path to GKE with HA and DR — see
  `docs/DEPLOYMENT_PLAN.md`.

## Status: Phase P8 delivered — all numbered phases complete

Phases P0 through P5 and P7 through P8 are done: the operation table and
dispatcher (`src/ops/`), application config and scheduling (`src/config/`),
the wiring module that assembles them into a running process
(`src/provisioning/wiring.ts`), the HTTP surface (`src/http/`) —
`openapi.yaml`'s routes, bearer-JWT auth, and the NDJSON streaming search —
in-process partition maintenance (`src/ops/PartitionMaintainer.ts`), the
service-level config block: dispatcher pool size/claim interval/reaper
threshold, plus two boot-time cross-validations (issuer/JWKS same host,
refuses to boot; inbound audience vs. `IGA_CLIENT_ID` collapse, warns), and
the integrated soak (`npm run soak:http`) verified clean against a real
Cloud SQL instance — real loader, real HTTP routes and auth, real Postgres.
`src/index.ts` is the real entrypoint: it starts the data path, mounts the
HTTP server, and drains on `SIGTERM`/`SIGINT`.

See [`docs/PROVISIONING_SERVICE_PLAN.md`](./docs/PROVISIONING_SERVICE_PLAN.md)
for the phases (P6 — metrics binding — was deferred wholesale to the standing
**Backlog** section, since it blocks neither P7 nor P8) and, at the top of
that file, the P0 findings.

## Architecture

```
HTTP request
  │
  ▼
requireJwt()              src/http/auth.ts          bearer-JWT, boot-validated
  │
  ▼
admission                 src/ops/admission.ts       schema/object-class/naming
  │                                                   validation, lane-key assignment
  ▼
OperationStore.enqueue()  src/ops/OperationStore.ts  durable INSERT, idempotency dedup
  │
  ▼
Postgres: operations table, status PENDING  ──────►  202 + operationId, to the caller
  ▲                                                   (caller polls GET /operations/:id)
  │  claim, SKIP LOCKED
  │
Dispatcher claim loop     src/ops/Dispatcher.ts      priority scheduling, lane
  │                                                   serialization, retry/backoff
  ▼
ConnectorManager / facade                     @governance-connector-framework/core
  │
  ▼
target system, via an OpenICF-compatible connector bundle
  │
  ▼
finalize() → Postgres: terminal outcome (SUCCEEDED / REJECTED_PRE_DISPATCH /
                                          FAILED_CONFIRMED / INDETERMINATE)
```

- **`src/http/`** — routes (`openapi.yaml`'s contract), bearer-JWT auth,
  `/healthz`/`/readyz`, NDJSON streaming search, the two boot-time
  cross-validations.
- **`src/ops/admission.ts`** — synchronous validation and lane-key
  assignment, before a mutation is durably queued; this is where a bad
  request gets rejected fast, not after it's already in the table.
- **`src/ops/OperationStore.ts`** — the durable operation table: enqueue,
  claim (`SKIP LOCKED`), finalize, reap rows stranded by a dead dispatcher,
  partition-aware.
- **`src/ops/Dispatcher.ts`** — the claim loop: priority scheduling (the
  reserved interactive slice), lane serialization, retry/backoff, read-back
  deferral for a create whose outcome timed out (resumes by searching for
  the object, never re-issues the create).
- **`src/ops/PartitionMaintainer.ts`** — keeps the table's day-partitions
  alive and drops retention-expired ones, in-process, no external cron.
- **`src/provisioning/wiring.ts`** — assembles all of the above into one
  running process; the only module that knows how to start or stop the
  whole thing together.
- **The framework** (`@governance-connector-framework/core`, a separate
  repo) — connector loading, registry, manager, and facade: executes one
  connector operation correctly (attempt deadlines, abort propagation,
  circuit breakers, connection pooling). This service never talks to a
  connector directly, only through the facade.

## Design

Four terminal outcomes, deliberately distinct because the remedy differs:

| Outcome | Meaning | Remedy |
|---|---|---|
| `SUCCEEDED` | The target applied it. | none |
| `REJECTED_PRE_DISPATCH` | Never reached the target. | retry wholesale |
| `FAILED_CONFIRMED` | The target refused. | will refuse again; fix the input |
| `INDETERMINATE` | The deadline expired with no answer. | reconciliation only |

Operations serialize by lane so two writes to the same object cannot
interleave: `create:<objectClass>:<nameAttrValue>` for creates,
`uid:<objectClass>:<uid>` for update, delete, and deltas.

The HTTP contract is [`openapi.yaml`](./openapi.yaml). Its schema vocabulary
came from the framework at CP-5; the paths are implemented (Phase P4) and
that file is now the authority over the plan's prose, not the reverse.

## Documentation

- [`docs/PROVISIONING_SERVICE_PLAN.md`](./docs/PROVISIONING_SERVICE_PLAN.md)
  — the design record: every phase, what was decided and why, findings
  recorded in place (strikethrough + explanation) rather than silently
  changed. A standing **Backlog** section holds work that doesn't block a
  numbered phase.
- [`docs/DEPLOYMENT_PLAN.md`](./docs/DEPLOYMENT_PLAN.md) — local Docker
  through GKE, with HA and DR: the container image, the local-dev and
  image-build/publish runbooks, and the (not-yet-built) k8s design.
- [`docs/BUG_LOG.md`](./docs/BUG_LOG.md) — defects found outside the normal
  review cycle. Append-only in spirit: entries are edited to change status
  and add resolution notes, not rewritten.
- [`openapi.yaml`](./openapi.yaml) — the HTTP contract.
- The framework repo's own `governance-connector-framework_checkpoint_log.md`
  (a separate repository) records the framework/service boundary decisions
  (CP-5 onward) this service's design leans on.

## Development

```bash
npm ci
npm run build
npm test
npm run lint
```

### Database

```bash
eval "$(bash scripts/test-pg.sh)"   # throwaway local server -> DATABASE_URL
bash scripts/db-setup.sh            # seed the schema and partitions
bash scripts/db-setup.sh --dry-run  # report without changing anything
```

`db-setup.sh` inspects the target rather than being told what state it is in.
A database with no `operations` table gets `schema.sql`; one that predates
Phase 11 gets migration 002 instead. That distinction is the whole point:
every statement in `schema.sql` is `IF NOT EXISTS`, so applying it to an old
table succeeds and the failure surfaces much later as "column terminal does
not exist" from the claim query.

It is idempotent, seeds today's and tomorrow's partitions — a range-partitioned
table with no partition covering `now()` rejects every insert — and asserts its
post-conditions on every run.

Migration 002 adds a `STORED` generated column, which rewrites the table under
`ACCESS EXCLUSIVE`. Drain the dispatchers first; it is not safe to run
alongside a live claim loop.

Node 22. TypeScript strict, with `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` copied from the framework so code moves between the
two repositories without a typecheck surprise.

### Running

```bash
DATABASE_URL=postgres://...            \
CONNECTOR_BUNDLE_DIR=/path/to/bundles  \
APP_CONFIG_DIR=/path/to/app-configs    \
JWT_JWKS_URI=https://.../jwks.json     \
JWT_EXPECTED_ISS=https://issuer:443    \
JWT_EXPECTED_AUD=provisioning-service  \
npx tsx src/index.ts
```

`PORT` defaults to 3000. `wiring.ts`'s own config (drain budget, shutdown
grace, pool statement timeout) and `auth.ts`'s (allowed algorithms, clock
skew, max token age, required scope) each have documented defaults — see
those files' `loadWiringConfig()`/`validateJwtConfig()` for the full env var
list. `SIGTERM`/`SIGINT` close the HTTP server first, then drain the
dispatcher, so nothing new can enqueue while in-flight work finishes.

`GET /healthz` and `GET /readyz` are unauthenticated (mounted ahead of
`requireJwt()`), for a container orchestrator's liveness/readiness probes —
see `src/http/healthRoutes.ts`.

### Docker

```bash
bash scripts/preflight.sh   # checks Docker/Compose/ports before anything else does
docker compose up --build
docker compose logs jwks    # copy the printed bearer token
curl -X POST http://localhost:3000/instances/demo-instance/objects/__ACCOUNT__ \
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"attributes":{"__NAME__":"alice"},"priority":"interactive"}'
```

Brings up Postgres, applies the schema, a throwaway local JWT issuer, and the
service itself, wired to the fixture connector the test suite already uses —
a clean checkout to a working stack in one command. See
[`docs/DEPLOYMENT_PLAN.md`](./docs/DEPLOYMENT_PLAN.md) for the full guide:
what each compose service does, the standalone image build-and-publish
runbook, and the GKE/HA/DR design this local setup leads to.

[fw]: https://github.com/srallapally/governance-connector-framework
