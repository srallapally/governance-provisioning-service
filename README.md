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

See [`PROVISIONING_SERVICE_PLAN.md`](./PROVISIONING_SERVICE_PLAN.md) for the
phases (P6 — metrics binding — was deferred wholesale to the standing
**Backlog** section, since it blocks neither P7 nor P8) and, at the top of
that file, the P0 findings.

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

`GET /healthz` and `GET /readyz` are unauthenticated (mounted ahead of
`requireJwt()`), for a container orchestrator's liveness/readiness probes —
see `src/http/healthRoutes.ts`.

### Docker

```bash
docker compose up --build
docker compose logs jwks   # copy the printed bearer token
curl -X POST http://localhost:3000/instances/demo-instance/objects/__ACCOUNT__ \
  -H "Authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"attributes":{"__NAME__":"alice"},"priority":"interactive"}'
curl http://localhost:3000/operations/<operationId> -H "Authorization: Bearer <token>"
```

Brings up Postgres, applies the schema (`migrate`, one-shot, via the same
`scripts/db-setup.sh` real operators use), a throwaway local JWT issuer
(`jwks` — dev-only, never production, see `scripts/dev-auth.ts`), and the
service itself, wired to the fixture connector the test suite and soak
scripts already use (`test/fixtures/connectors`) so there's something real
to exercise from a clean checkout in one command.

`Dockerfile`'s `runtime` target (the default) is what a real deployment
ships: non-root, dev-dependency-free, connector bundles baked in at build
time rather than mounted — see `docker/connector-bundles/README.md` for how
a real build supplies real bundles. HA and DR are
[`DEPLOYMENT_PLAN.md`](./DEPLOYMENT_PLAN.md)'s job, not this compose file's;
it exists to get a developer from a clean checkout to a working stack, not
to model production topology.

#### Building and publishing the production image

`docker compose build` above is for local iteration; this is the
standalone runbook for producing the actual image a deployment ships.
GKE-specific automation (a CI build-and-push stage) is still unbuilt — see
`DEPLOYMENT_PLAN.md`'s "CI/CD (sketch, not built)" — so today this is a
manual sequence, not yet a pipeline step.

1. **Supply real connector bundles.** `docker/connector-bundles/` is
   intentionally empty (this repo doesn't own any real bundle) and the
   `Dockerfile` bakes its contents in directly, by fixed path — there's no
   build ARG that can point elsewhere, because Docker's `COPY` can never
   reach outside the build context regardless of what a `--build-arg`
   value says (see that directory's own README, which explains this the
   hard way). Replace its contents before building:

   ```bash
   rm -rf docker/connector-bundles/*
   cp -r /path/to/external-connectors/dist/* docker/connector-bundles/
   docker build -t governance-provisioning-service:local .
   ```

   Building with the default (empty) bundles directory produces a valid
   image that boots and answers `/healthz`/`/readyz`, but
   `loadExternalConnectors` will have nothing to register — fine for
   verifying the image itself, not for a real deployment.

2. **Smoke-test the image standalone**, against any reachable Postgres
   with the schema already applied (`scripts/db-setup.sh` — see the
   Database section above) and a real JWKS. Same env vars as the "Running"
   section above, just via `docker run` instead of `npx tsx`:

   ```bash
   docker run --rm -p 3000:3000 \
     -e DATABASE_URL=postgres://...            \
     -e APP_CONFIG_DIR=/config                  \
     -v /path/to/app-configs:/config:ro         \
     -e JWT_JWKS_URI=https://.../jwks.json      \
     -e JWT_EXPECTED_ISS=https://issuer:443     \
     -e JWT_EXPECTED_AUD=provisioning-service   \
     governance-provisioning-service:local
   curl http://localhost:3000/healthz
   curl http://localhost:3000/readyz
   ```

   `APP_CONFIG_DIR` needs a mounted volume here (it's not baked into the
   image — see the config-delivery decision in `DEPLOYMENT_PLAN.md`);
   `CONNECTOR_BUNDLE_DIR` doesn't, since the image already sets it to
   `/app/connector-bundles` and bundles were baked in at build time above.

3. **Tag and push.** `DEPLOYMENT_PLAN.md`'s sketch: tag by commit SHA
   (immutable, traceable to the exact source), plus `latest` only on
   builds from `main`. Example against GCP Artifact Registry (adjust
   region/project/repo to the target environment — none of this is
   hardcoded anywhere, this is illustrative):

   ```bash
   gcloud auth configure-docker REGION-docker.pkg.dev
   IMAGE=REGION-docker.pkg.dev/PROJECT/REPO/governance-provisioning-service
   SHA=$(git rev-parse --short HEAD)

   # docker/connector-bundles/ already holds real bundles, per step 1
   docker build -t "$IMAGE:$SHA" .
   docker push "$IMAGE:$SHA"

   # only on main:
   docker tag "$IMAGE:$SHA" "$IMAGE:latest"
   docker push "$IMAGE:latest"
   ```

   Any OCI registry works the same way — Artifact Registry is this
   example's target because the project already runs on GCP (Cloud SQL),
   not because anything here depends on it specifically.

[fw]: https://github.com/srallapally/governance-connector-framework
