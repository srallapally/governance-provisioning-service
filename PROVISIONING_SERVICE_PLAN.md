<!-- PROVISIONING_SERVICE_PLAN.md -->

# Provisioning service: extraction + integration plan

## P0 findings — scaffold path taken

Recorded 2026-08-01. Phase P0 asks for findings if a middleware repo exists
and recorded choices if scaffolding fresh. **No middleware repo was
available**, so this is the scaffold path.

What was checked: the account's repository list was searched for a
provisioning or middleware service and returned nothing matching. The
framework repo (`srallapally/governance-connector-framework`) is the only
related codebase reachable from this session. Nothing was inherited; every
line below is a decision, not an observation.

### Repository

| | |
|---|---|
| **Package name** | `governance-provisioning-service`, single package, not a monorepo |
| **Private** | yes — a deployable service, never published to a registry |
| **Base branch** | `main`, an empty root commit; all P0 work on `feature/provisioning-service` |
| **Node** | 22 (`.nvmrc`, `engines.node >=22.0.0`, CI `node-version: 22`) |

The framework declares `engines.node >=20.12.0` and builds on Node 20 in CI.
This service moves to 22 as instructed. Nothing in the extraction depends on a
Node 20 API, so P1 is not expected to notice.

### Toolchain

**TypeScript.** `compilerOptions` are copied verbatim from the framework's
`packages/core/tsconfig.json`, not reinvented — `target: ES2022`, `module` and
`moduleResolution: NodeNext`, `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `composite`, `declaration`/`declarationMap`/
`sourceMap`, `esModuleInterop`, `forceConsistentCasingInFileNames`,
`skipLibCheck`, `resolveJsonModule`. `include`/`exclude` match too.

Both strict flags were verified to actually reject code, rather than merely
being present in the file: an unchecked index access failed with TS2322 and an
explicit `{ p: undefined }` against `p?: string` failed with TS2375.

Two deviations from a verbatim copy, both deliberate:

- The framework's `ts-node` block (overriding `module` to CommonJS) is
  omitted. There is no ts-node in this stack; the framework uses `tsx` where
  it needs to run TypeScript directly, and P1's soak script will do the same.
- `rootDir`/`outDir` stay `src`/`dist`, which is what the framework uses.

**vitest** ^3.2.4, matching the framework. Configured with
`passWithNoTests: true` because P0 ships no code — without it CI would be red
for the absence of tests rather than for a defect. P1 brings the contract
suite and that flag stops mattering.

**eslint** ^9.10.0 with a real flat config and `typescript-eslint` ^8.8.0.
This diverges from the framework, which declares `eslint . || true` and ships
**no config file at all** — linting there is a no-op that cannot fail. Here
`npm run lint` is fatal and runs in CI. Cheaper to hold the line from the
first commit than to retrofit it over a dispatcher.

### Choices for the items P0 asks about

| Item | Choice | Settled at |
|---|---|---|
| HTTP framework | Express 5 | P4 |
| Route registration | Explicit router module per plane (mutations, status, reads) | P4 |
| Validation | Hand-rolled, mirroring `resolveRuntimeConfig`'s style | P4 |
| pg pool construction | `pg` `Pool`; dispatcher pool separate from any API pool, max 5, `statement_timeout` set | P2 |
| Config system | Environment variables for service-level settings; one JSON file per connector instance | P7 |
| Logging | Structured JSON to stdout, no library until there is a reason for one | P6 |
| Metrics stack | **Undetermined** — see below | P6 |
| SIGTERM handling | `wiring.stop()`: stop claiming, drain in-flight to a budget, release leases, close pools | P2 |
| Instance config location | **Undetermined** — see below | P1/P7 |
| Schema delivery | **Undetermined** — see below | P3 |

Express 5 is chosen rather than invented: the framework already carries
tested Express 5 middleware in `packages/websocket/src/security/` — `auth.ts`
(JWT bearer via `jose`, JWKS, replay cache), `csrf.ts`, and `hardening.ts`
(helmet, CORS, rate limiting, body limits). No in-repo server mounts them,
which makes them available precedent rather than a live dependency. CP-1 says
this service is the single trusted caller surface and new routes sit behind
existing service auth; reusing that middleware is the shortest path to it.

**No runtime dependencies are installed in this phase.** Express, `pg`, and
the core package arrive when the code that needs them does — `pg` and core at
P1, Express at P4. P0's acceptance is "no code", and a dependency with no
consumer is code's shadow.

Validation stays hand-rolled to match core: `resolveRuntimeConfig` rejects
unknown keys by name without a schema library, and instance config validation
here must produce the same messages. Note the framework is not uniform on
this — `packages/websocket/src/security/hardening.ts` does use zod for HTTP
input. If P4's route validation wants zod, that is a defensible split
(config hand-rolled, HTTP bodies schema-checked) and should be decided there,
not assumed here.

### Could not be determined

These are the P0 discovery items with no answer available from this session.
Each blocks a later phase and needs an operator answer before that phase runs.
Numbering is stable; an item answered later is marked in place rather than
renumbered away.

1. ~~**Metrics stack**~~ — **ANSWERED 2026-08-01: there is no metrics stack.**
   No Prometheus, no OTLP collector, no vendor agent. One may be added later.

   Consequence: "the P0-discovered stack" is the empty set, so P6's original
   acceptance — "visible in the dev stack during a manual fake-connector run"
   — is unsatisfiable as written. **P6 is revised below** rather than left to
   fail its own acceptance.

   The shape this settles on: `MetricsSink` stays an interface, which is the
   framework's design and the reason it bundles no client library. The service
   ships a stdout sink and an in-memory snapshot sink. Adding Prometheus later
   is one more implementation plus a scrape config, with no call site moved.
   **No metrics client library becomes a dependency until a stack exists to
   talk to.**
2. **Dev Cloud SQL instance** — blocks P3. The plan names "dev Cloud SQL" and
   P3's acceptance needs a `DATABASE_URL` at a scratch database on it.
   Connection details, auth method (IAM vs password, proxy vs direct), and
   whether the Postgres major version matches the 16 the framework verified
   against are all unknown.
3. **How schema changes reach databases today** — blocks P3. `schema.sql` and
   `migrations/002_status_and_optype.sql` exist, but there is no discovered
   migration runner, no convention for ordering, and no answer on whether the
   service applies migrations at boot or an operator applies them out of band.
   P3 says "record path taken and commands here", which presumes a path.
4. ~~**Where per-application instance configs live**~~ — **ANSWERED
   2026-08-01: each application instance config is a JSON document stored in
   the IGA repository and handed to the engine as an object, `ApplicationConfig`.**

   **Retrieval, settled 2026-08-01:** the service **pulls** the config rather
   than receiving it pushed at boot. Given an application id, it asks an
   `ApplicationConfigStore` and gets back an `ApplicationConfig`. The default
   implementation reads a JSON file per application from a directory, chosen
   for ease of testing; a store backed by the IGA repository replaces it later
   without touching a call site.

   ```ts
   interface ApplicationConfigStore {
       // Returns null when no application has that id.
       get(applicationId: string): Promise<VersionedApplicationConfig | null>;
   }

   interface VersionedApplicationConfig {
       config: ApplicationConfig;
       // Opaque; changes whenever the document changes. The file store uses
       // a content hash. Compared, never parsed.
       version: string;
   }
   ```

   This settles the boot-versus-runtime question by making it moot: a config
   is whatever the store returns at the moment it is asked, so a change during
   the process's life is expected rather than exceptional. Two consequences
   follow that the implementation has to face rather than discover.

   **It is a hot path.** "Retrieve when it performs the op" means one store
   read per operation, and the recorded pg soak runs at ~1,168 ops/s. A file
   read per operation at that rate is not free, and an IGA-repository-backed
   store later would be far worse. Resolve the config **once per attempt**, at
   claim time, not per SPI call, and cache by `(applicationId, version)`. The
   file store's version is a content hash, so a stale cache entry is detected
   by a `stat` and a re-read rather than by a timer.

   **A version change invalidates a built connector instance.** The registry
   caches the materialized instance and `ConnectorManager` hands out refcounted
   leases with an idle TTL. When the version changes, the cached instance was
   built from the old config and is wrong. Re-registration must therefore
   dispose the old instance only after its outstanding leases drain — the same
   discipline `stop()` uses at P2. Operations already in flight keep the
   config they started with; that is the correct behaviour, because an attempt
   deadline that changes underneath a running attempt would make the create
   read-back window incoherent.

   Do not confuse the config store with the connector bundle directory, which
   is a different thing: the framework's `ExternalLoader` scans it for
   `manifest.json` to load connector **code**. Concretely, the service calls
   `registerFactory` from the loader and `registerInstance` from a config the
   store returned, rather than letting the loader instantiate
   `manifest.instances`.

   The split, per CP-5's rule:

   | `ApplicationConfig` field group | Goes to |
   |---|---|
   | instance id, connector type + version, connector config | `registerInstance` identity |
   | `attemptDeadlineMs`, `mutationConcurrency`, `readConcurrency`, `readCache` | core's `resolveRuntimeConfig` |
   | `interactiveSliceFraction`, per-op `rateLimits` | this service's scheduling config |

   Core rejects the scheduling keys by name, so passing an unsplit
   `ApplicationConfig` straight through fails loudly rather than silently
   dropping them. That is the intended behaviour and P1's split must happen
   before the call, not after a caught error.

   Registration is therefore **not** a startup event. Nothing is registered
   eagerly at boot; an application becomes known the first time an operation
   names it. That matches the framework's own lazy lifecycle — CP-3 rejected
   eager `initInstance` looping at boot for the same reason — and it means a
   newly onboarded application needs no restart.
5. **Deployment target** — not named in P0's list but implied by P5, which
   rejects "a k8s CronJob (new pod)" in favour of an in-process timer. That
   phrasing assumes Kubernetes. Confirmation is needed before P5's design is
   load-bearing.
6. **Existing service auth** — CP-1 says new routes sit behind it. With no
   middleware repo there is no existing auth to sit behind, so P4 either
   adopts the framework's JWT bearer middleware or receives a decision.

### Deferred to the phase that needs them

Recorded so they are not rediscovered as surprises:

- **Core dependency form.** P1 pins `@governance-connector-framework/core` as
  a git dependency at the F13 commit. That commit is `e633763` on the
  framework's `feature/async-provisioning`. The framework has since squash-
  merged to `main` as `38c2397`, so the F13 commit is reachable only from the
  feature branch ref — which is why that branch was restored after the merge
  deleted it. P1 should pin the SHA, not the branch name.
- **Extraction source.** The files P1 receives live at `e633763~1`
  (`packages/core/src/ops/`: `Dispatcher.ts`, `OperationStore.ts`,
  `admission.ts`, `index.ts`, `schema.sql`, `migrations/`). There is no tag —
  the framework's remote rejects tag pushes — so that SHA is the only pointer.
- **BUG-4** is not filed here yet. P1.5 opens it as this repo's first entry,
  per the plan.

---

Supersedes INTEGRATION_PLAN.md.

## End state (three repos)

1. `governance-connector-framework` — connector execution only: SPI, loader,
   manager, facade, infra; packages `core` and `websocket`. OpenICF-aligned;
   knows nothing about provisioning operations.
2. provisioning service (this plan's target repo) — operation table,
   dispatcher, admission, routes, wiring, deployment. Consumes core.
3. `external-connectors` — connector bundles; builds against core types.
   Untouched by this plan.

Split rule for every borderline symbol: what the facade needs to execute one
operation stays in the framework; what only the claim loop needs moves here.

Design authority unchanged: framework `CLAUDE_CODE_PLAN.md`, checkpoint log
CP-1..CP-6, `BUG_LOG.md`, `openapi.yaml`. The provisioning-operation parts of
`openapi.yaml` (202 contract, status endpoint, outcome taxonomy) move to this
repo with the code.

## Ground rules

- Framework work happens on `feature/async-provisioning` in the framework
  repo; service work on a feature branch here. One phase per commit.
- Dev-phase dependency: `@governance-connector-framework/core` as a git
  dependency pinned to the commit produced by Phase F13. Swap for a published
  version after the framework merges to main.
- Never patch framework code from this repo; file framework defects in the
  framework's BUG_LOG.md.
- This service is the single trusted caller surface (CP-1). New routes sit
  behind existing service auth.
- Start a BUG_LOG.md here with the same conventions the framework's uses.

## Phase F13 (framework repo): extraction, framework side

One commit on `feature/async-provisioning`:

- Delete `packages/core/src/ops/` (store, dispatcher, admission, schema.sql,
  migrations) and its barrel export from `src/index.ts`.
- Move `OperationOutcome` out of `spi/types.ts`; it leaves with the
  dispatcher. `OperationOptions` keeps `abortSignal`, `deadlineEpochMs`,
  `priority` (ICF options bag is extensible; the facade enforces deadlines for
  any caller).
- Split runtime config by the split rule. Core keeps: `attemptDeadlineMs`
  (facade deadline derivation), mutation/read concurrency (breaker limits),
  read-cache opt-in. Remove from core: `interactiveSliceFraction` and per-op
  rate limits (claim-loop concerns; they move to the service).
  `resolveRuntimeConfig` and its tests shrink accordingly.
- Add a testing subpath export `@governance-connector-framework/core/testing`
  exposing `FakeConnector`, `clock`, `async` (deferred/barrier). ICF's
  test-common is the precedent. `MemoryOperationStore`, the contract suite,
  `describeWithPg`/`pg.ts`, `test-pg.sh`, and `soak.ts` do NOT stay; they
  leave with the ops code (Phase P1).
- Docs: README drops the async-provisioning sections, pointing at the
  provisioning service instead. Bug log entries stay (history), marked
  "component moved".

**Accept:** both packages build; remaining core tests green
(connector-execution tests only); websocket 242 unchanged;
`grep -r "OperationStore\|Dispatcher\|OperationOutcome" packages/` returns
nothing outside git history. Take CP-5 in the framework log recording the
boundary decision and the split rule.

## Phase P0: service repo discovery / scaffold

If the middleware repo exists: record HTTP framework, route registration,
validation, existing pg pool construction, config system, logging, metrics
stack, SIGTERM handling, where per-application instance configs live, and how
schema changes reach databases today. If scaffolding fresh: Node 22,
TypeScript strict matching the framework's tsconfig
(`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), vitest, eslint;
record the choices instead.

**Accept:** findings at the top of this file; no code.

## Phase P1: receive the extraction

- Add core git dependency pinned to the F13 commit.
- Bring over, with imports rewritten to local paths: `OperationStore`,
  `Dispatcher`, admission, `schema.sql`,
  `migrations/002_status_and_optype.sql`, `OperationOutcome` (now local, e.g.
  `src/ops/types.ts`), scheduling config (slice fraction, rate limits)
  composed on top of core's runtime config.
- Instance config contract, settled at P0: one JSON per application instance,
  fetched by application id from an `ApplicationConfigStore` at the moment an
  operation needs it. Define `ApplicationConfig`,
  `VersionedApplicationConfig`, and the store interface here, plus the file
  store as the default implementation — a directory of JSON documents, version
  = content hash. Split the config: identity and execution fields pass into
  `registerInstance`; scheduling fields stay here, validated with the same
  rules (slice floor only when fraction > 0, per RFE-1/CP-4). Split before the
  call — core rejects the scheduling keys by name, so an unsplit config passed
  through throws rather than degrading quietly. Resolve once per attempt at
  claim time and cache by `(applicationId, version)`; a version change
  re-registers the instance after outstanding leases drain. The connector
  bundle directory is unaffected; the loader still supplies factories, it just
  no longer instantiates `manifest.instances`.
- Bring the ops test infrastructure: `MemoryOperationStore`, the contract
  suite, `pg.ts`/`describeWithPg`, `scripts/test-pg.sh`, `soak.ts` with its
  recorded baseline header. Connector fixtures import from
  `@governance-connector-framework/core/testing`.

**Accept:** full suite green here, including the pg tier against a local
apt-installed Postgres via `test-pg.sh` (CC web has no Docker); contract suite
passes against both stores; soak runs and reproduces the baseline within
reason (record the numbers).

## Phase P1.5: enforce the interactive slice (BUG-4)

Authority: framework BUG_LOG.md BUG-4, MOVED here at CP-5. Open this repo's
BUG_LOG.md with BUG-4 as its first entry, linking back, then fix it.

The gap: `resolveRuntimeConfig` computes `interactiveSlots`/`batchSlots` and
nothing consumes them. `computeAvailability` offers one number per instance,
so batch work can hold every slot and an interactive operation waits an
attempt duration (CP-2 LOCKED the asymmetry: interactive may use all slots,
batch capped at budget minus slice).

The fix:

- Dispatcher counts in-flight per class per instance, not just per instance.
- `computeAvailability` yields two numbers:
  `batchFree = batchSlots - batchInFlight`,
  `totalFree = mutationConcurrency - inFlight`.
- `claimBatch` takes both: up to `batchFree` batch rows, up to `totalFree`
  rows overall, interactive filling the remainder. Ordering (interactive
  first) stays.
- Scheduling config for slice lives here since CP-5; no core change.

Tests:

- The discriminating test from BUG-4's notes: saturate an instance with slow
  batch work (FakeConnector `latency`), enqueue an interactive op, assert it
  starts before any in-flight batch attempt completes.
- Batch never exceeds `batchSlots` on a saturated instance; interactive
  exceeds it up to the full budget when batch is idle.
- Budget 1 (no reservation) and fraction 0 (RFE-1: zero slots) still behave.

**Accept:** tests green including the pg tier; BUG-4 closed FIXED in this
repo's log with the commit; framework's BUG-4 entry updated with the
destination link.

## Phase P2: wiring module

`src/provisioning/wiring.ts` constructing in order: dispatcher pg pool
(separate from any API pool; small, max 5, `statement_timeout` set),
`OperationStore`, `ConnectorRegistry` + loader at the connector bundle
directory, `ConnectorManager`, `MetricsSink` (console until P6), `Dispatcher`.
Export `start()`/`stop()`. `stop()`: stop claiming, drain in-flight up to a
budget, release leases, close pools. Wire into SIGTERM. Data path uses
`ConnectorManager.acquire` only; never loop `initInstance` at boot (rebuilds
eager boot).

**Accept:** boots with wiring active, no routes; SIGTERM with an in-flight
fake op drains then exits.

## Phase P3: dev Cloud SQL schema

- Fresh database: apply `schema.sql`, then create today's and tomorrow's
  partitions.
- Pre-Phase-11 database: apply migration 002 by hand; `schema.sql` is
  IF NOT EXISTS and fails later on an old table ("column terminal does not
  exist").
- Record path taken and commands here. Verify: `terminal` generated column,
  `not_before`, `drop_operations_partition`, op_type includes
  ADD_VALUES/REMOVE_VALUES.

**Accept:** this repo's pg contract suite passes with DATABASE_URL at a
scratch database on the dev instance.

## Phase P4: routes

`openapi.yaml` (now owned here for the provisioning surface) wins over this
text.

Mutations (create/update/delete/add-values/remove-values): synchronous
validation (schema, object class, uid for uid-keyed ops, naming attribute for
create) with 400 while the caller waits; `priority` from caller provenance,
default batch; idempotency key from caller request id, else generated;
enqueue; 202 + operationId. `AdmissionRejectedError` → 429 with backlog depth.

Status: `GET /operations/:id` → status, outcome, error code, result (Uid,
object) on success. No long-poll this phase.

Read plane: get/search acquire through `ConnectorManager`, release in
`finally`. Search streams NDJSON; handler false on full response buffer,
resume on drain; no buffering.

**Accept:** route tests with `FakeConnector` through the real loader:
202→SUCCEEDED with Uid; 429 with depth at cap; ADD_VALUES enqueue; 10k-object
search with bounded memory, asserted by observation not vibes.

## Phase P5: partition maintenance in-process

No k8s CronJob (new pod). Hourly timer in the dispatcher process: ensure
today+tomorrow partitions; drop older-than-retention via
`drop_operations_partition` only; whole pass under `pg_advisory_xact_lock`. A
refused drop increments a metric and warn-logs partition name and row count;
the refusal is correct and must be loud (BUG-2's lesson).

**Accept:** partition with a PENDING row survives and increments the metric;
terminal-only past-retention partition drops; two concurrent passes do the
work once.

## Phase P6: metrics binding

Revised at P0: there is no metrics stack to bind to. The instrumentation is
still worth having — the surface below is what an operator needs to answer
"is provisioning falling behind" — so the phase keeps its content and changes
only where the numbers go.

Surface: backlog depth and oldest-pending age per instance (primary operator
signals), outcome counts, attempt latency, breaker transitions, event-loop
lag, live instances, pool in-use, partition-drop refusals.

Implement two `MetricsSink`s and nothing else:

- a **stdout sink** emitting one structured JSON event per measurement, so
  metrics land wherever logs already land;
- an **in-memory snapshot sink** holding current values, readable in-process.

No metrics client library becomes a dependency. When a stack appears it is a
third implementation plus deployment config, and no call site moves — which is
exactly why `MetricsSink` is an interface rather than a concrete exporter.

Event-loop lag is the one measurement with a decision riding on it: the
sidecar split has been deferred since CP-1 waiting on production numbers, and
P8 is where that dataset starts. Emitting it to stdout is enough to begin
collecting; it does not need a stack.

**Accept:** a manual fake-connector run emits every metric named above on
stdout, and the snapshot sink's backlog depth and oldest-pending age match a
direct SQL query against the operation table — the query is the oracle, since
there is no dashboard to eyeball. Deferred: binding to a real stack, and the
sidecar threshold that waits on one.

## Phase P7: configuration

Config block: dispatcher pool size, retention window, reaper threshold, claim
interval, drain budget, connector directory. Note the split settled at P0 —
this block is service-level and environment-sourced, whereas per-application
instance settings arrive as `ApplicationConfig` objects and never appear here.

Add the config-store block: which store implementation, and for the file
store, the directory it reads.

Instance configs flow per the P1 contract — pulled by application id, not
loaded at boot. Registration is lazy, so a validation failure surfaces when
an operation for that application is first dispatched rather than at startup.
That is later than a startup check would catch it, and the compensation is
that the failure must be unmistakable: fail the operation
`REJECTED_PRE_DISPATCH` — it never reached the target — name the application
and the offending setting, and do not retry a config that cannot parse.

**Accept:** an application whose config carries `attemptDeadlineMs: -1` fails
with the ceiling named and the application id in the message; the operation
records `REJECTED_PRE_DISPATCH` rather than being retried; a config edited to
a valid value is picked up on the next operation with no restart.

## Phase P8: integrated soak

Fake connectors, real loader, real routes, dev Cloud SQL. Reproduce the soak
scenarios end to end; compare with the P1 baseline; record the Cloud SQL
delta. The interactive-latency scenario uses the P1.5 assertion, an
interactive op against a batch-saturated slow instance starts before any
in-flight batch attempt completes, not the ordering-satisfiable
`interactive p50 < batch p50`. Watch event-loop lag: begins the dataset the
sidecar decision (open since CP-1) waits on.

**Accept:** numbers recorded here; zero INDETERMINATE without injected faults;
CP-7 in the framework log covering integration results (CP-5 was the
extraction).

## After P8

Framework PR `feature/async-provisioning` → `main`; publish
`@governance-connector-framework/core` (GitHub Packages npm, semver) and swap
this repo's git dep for the published version; external-connectors CI pins the
published core for type builds. Production rollout; sidecar threshold waits on
real metrics.
