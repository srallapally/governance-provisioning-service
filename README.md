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

## Status: Phase P4 delivered

Phases P0 through P4 are done: the operation table and dispatcher (`src/ops/`),
application config and scheduling (`src/config/`), the wiring module that
assembles them into a running process (`src/provisioning/wiring.ts`), and the
HTTP surface (`src/http/`) — `openapi.yaml`'s routes, bearer-JWT auth, and the
NDJSON streaming search. `src/index.ts` is the real entrypoint: it starts the
data path, mounts the HTTP server, and drains on `SIGTERM`/`SIGINT`.

See [`PROVISIONING_SERVICE_PLAN.md`](./PROVISIONING_SERVICE_PLAN.md) for the
phases (P5 onward is not started) and, at the top of that file, the P0
findings — plus a standing **Backlog** section at the end for items that
don't block a numbered phase.

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

[fw]: https://github.com/srallapally/governance-connector-framework
