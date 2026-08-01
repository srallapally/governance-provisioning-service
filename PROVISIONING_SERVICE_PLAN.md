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
| Config system | Env vars for service-level settings; per-application config pulled from an `ApplicationConfigStore` | P1/P7 |
| Logging | Structured JSON to stdout, no library until there is a reason for one | P6 |
| Metrics stack | None exists — stdout sink + in-memory snapshot, no client library | P6 |
| SIGTERM handling | `wiring.stop()`: stop claiming, drain in-flight to a budget, release leases, close pools | P2 |
| Deployment | A single Docker container, not Kubernetes | P2/P5 |
| Outbound auth to IGA | OAuth client credentials, ported from the framework's `OAuthTokenProvider`; lazy refresh, fetched once at boot | P2/P7 |
| Inbound auth on routes | Bearer token from the same OAuth authority; port the framework's `auth.ts`. Needs issuer, JWKS URL, audience | P4 |
| Instance config location | JSON in the IGA repo, pulled by application id; file store by default | P1/P7 |
| Schema delivery | `scripts/db-setup.sh`, run out of band; inspects the target to choose schema vs migration | P3 |

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
2. **Dev Cloud SQL instance** — **still open, but rescoped and no longer
   blocking.** Connection details, auth method (IAM vs password, proxy vs
   direct), and the Postgres major version remain unknown.

   P3 originally proved the schema works, which needs any Postgres, not a
   managed one. That verification moved to P0 and is done — see P3 for what
   `scripts/db-setup.sh` was exercised against. What a real instance is still
   needed for is role permissions for runtime DDL, the pooling mode in the
   connection path, server version, connection limits, and latency. P1, P1.5,
   and P2 all run against the local server `scripts/test-pg.sh` provides. P8
   needs a real database regardless, and is the honest deadline.
3. **How schema changes reach databases today** — **answered in part at P0
   by supplying one.** `scripts/db-setup.sh` is the path: it inspects the
   target, applies `schema.sql` to a fresh database or migration 002 to a
   pre-Phase-11 one, seeds partitions, and asserts post-conditions. It is
   idempotent and has a `--dry-run`.

   It is deliberately **not** a general migration runner — there is no version
   table and no ordered migration chain, because there are exactly two states
   to reach and inspecting the target distinguishes them more reliably than a
   recorded version would. If the deployment already has migration tooling,
   this script is still the right thing to run under it.

   Still open: whether an operator runs it out of band or the service runs it
   at boot. **Recommendation: out of band.** Migration 002 adds a STORED
   generated column, which rewrites the table under ACCESS EXCLUSIVE and is
   explicitly unsafe alongside a live claim loop — running it from process
   start would put a table rewrite in the path of every deploy.
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
5. ~~**Deployment target**~~ — **ANSWERED 2026-08-01: a Docker container.**
   Kubernetes was the alternative; the simpler option was chosen deliberately.

   This strengthens P5 rather than changing it. P5 already rejected a k8s
   CronJob in favour of an in-process timer; in a plain container there is no
   CronJob to reject, so the in-process timer is the only option and its
   design is load-bearing rather than merely preferred. Two consequences
   follow from being one process in one container:

   - **Nothing else will restart it.** No kubelet liveness probe, no
     ReplicaSet. `stop()` on SIGTERM matters more, not less, and an unhandled
     rejection that kills the process is an outage rather than a restart.
   - **Partition maintenance has no fallback.** If the hourly timer stops, the
     table stops accepting inserts once the last partition's day passes. P5's
     metric on refused drops is not the only signal that matters — a *missing*
     partition needs one too.

6. **Existing service auth** — **outbound answered, inbound still open.**

   **Outbound (answered):** the service reaches into IGA using OAuth 2.0
   client credentials — client id, client secret, token URL — fetching an
   access token at startup and renewing it on expiry.

   The framework already has this working:
   `packages/websocket/src/server/OAuthTokenProvider.ts` implements the
   client-credentials grant with a 30-second early-expiry margin, optional
   scope/audience/resource, and `invalidate()` for a 401. **Port it, do not
   depend on it** — it lives in the websocket package, which is a deployable
   service rather than a library, and this repo consumes `core` only.

   Two details worth keeping from that implementation rather than
   re-deciding:

   - **Renewal is lazy, on use, not on a timer.** `getToken()` refetches when
     the cached token is inside the early-expiry margin. A background refresh
     timer would be a second thing to shut down cleanly and would keep firing
     in an idle container for no benefit.
   - **Still fetch once at `start()`.** Not for the token — the lazy path
     covers that — but so bad credentials fail at deploy time rather than on
     the first operation that needs IGA.

   This is what the IGA-backed `ApplicationConfigStore` (finding 4) will
   authenticate with. The file store needs none of it, so P1 and P1.5 are
   unaffected; the token provider is constructed at P2 and configured at P7.

   **Inbound — ANSWERED 2026-08-01: the same client-credentials access
   token.** Callers present a bearer token from the same OAuth authority this
   service uses outbound, and this service validates it. One authority, both
   directions.

   P4 ports `packages/websocket/src/security/auth.ts` on the same terms as the
   token provider — JWKS fetch and cache, algorithm allowlist, `iss`/`aud`
   checks, clock skew, replay cache. It is written and tested; it just has no
   server mounting it today.

   **The authority is ForgeRock AM** (Identity Cloud tenant
   `openam-qa-iga-jun25.forgeblocks.com`, realm `/`). A sample access token
   settles the open questions and raises two new ones.

   **JWT, not opaque — introspection is not needed.** `cts` is
   `OAUTH2_STATELESS_GRANT` and the claims decode, so JWKS validation is the
   right implementation and the RFC 7662 fallback is off the table.

   **The issuer string contains an explicit port and must be configured
   verbatim:**

   ```
   iss = https://openam-qa-iga-jun25.forgeblocks.com:443/am/oauth2
   ```

   Issuer validation is an exact string comparison, not a URL comparison.
   Configuring the same host without `:443` — which is what anyone would type
   from the browser address bar — fails every token with a mismatched-issuer
   error that looks nothing like a configuration typo. This is the single
   most likely way P4 loses an afternoon.

   Expected endpoints, **unverified**: this tenant is not reachable from the
   development sandbox (the egress proxy refuses the CONNECT). AM's
   conventional paths for this issuer are
   `{iss}/.well-known/openid-configuration` for discovery and
   `{iss}/connect/jwk_uri` for JWKS. Confirm both at P4 by fetching discovery
   and reading `jwks_uri` from it rather than assuming the path.

   **`aud` equals the client id, so it cannot separate callers.** The sample
   carries `aud: "idmAdminClient"` and `client_id: "idmAdminClient"` — AM's
   default for access tokens. That is the fallback posture named earlier, not
   the preferred one: a token audienced this way is accepted by anything that
   trusts the authority and that client, including this service, and
   including a token minted for a different purpose entirely.

   So **the scope claim carries the authorization decision, not the
   audience.** Require `fr:iga:*` (or a narrower provisioning-specific scope,
   which is worth requesting from the tenant's owner). Note the shape: AM
   emits `scope` as a **JSON array**, not the space-delimited string RFC 6749
   describes and most validators assume. A check written against a string
   silently matches nothing.

   Getting a distinct audience remains preferable and remains a tenant
   configuration change rather than a code change. Until then, record in the
   deployment notes that the provisioning API is reachable by any holder of an
   `idmAdminClient` token with `fr:iga:*`.

   **Grant type — settled: callers use `client_credentials`.** The sample's
   `authorization_code` grant and user `sub` were incidental to how it was
   obtained. No human sits behind an operation, so **the operation table needs
   no requester column** and P1 lands the schema unchanged. Had it gone the
   other way, that column would have been a migration against a partitioned
   table, which 002 already showed is an ACCESS EXCLUSIVE rewrite.

   **A cheaper fix for the audience problem follows from this.** With
   client_credentials, AM sets both `sub` and `aud` to the client id. So if
   callers authenticate as a *different client* than the one this service uses
   for its own outbound calls to IGA, then `aud` distinguishes them after all:

   - inbound tokens carry `aud = <caller's client>`, which this service
     accepts;
   - this service's own outbound token carries `aud = <service's client>`,
     which this service rejects.

   That restores the separation the preferred posture wanted, without asking
   the tenant owner to configure a custom audience — it needs only a second
   OAuth client, which is routine. **Recommended: do not reuse
   `idmAdminClient` for the service's outbound credentials.** If one client
   must serve both directions, the required scope is the only thing standing
   between a leaked outbound token and the provisioning API, and the
   deployment notes should say so.

   Other observations from the sample, none blocking: token lifetime is 3600s
   (`exp - iat`), and `jti` is present so the replay cache in `auth.ts` has a
   key to work with.

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

- Add core as a dependency pinned to the F13 commit. **Deviation, recorded at
  P1: a git dependency is not usable here.** npm resolves a git dependency to
  the repository *root*, and core is `packages/core` of a workspace -- npm has
  no subdirectory syntax for git deps, so `github:owner/repo#sha` would install
  the private workspace root, under the wrong package name, with no `dist`.
  Instead core is built from the pinned commit and vendored as a tarball at
  `vendor/governance-connector-framework-core-<version>-<sha>.tgz`, referenced
  by `file:`. The commit is in the filename, so the pin is visible in
  `package.json` and a re-vendor cannot silently reuse a cached tarball.
  `scripts/vendor-core.sh` regenerates it. This also has the property the plan
  wanted from publishing: every install exercises the *packaged* shape of core,
  which is how BUG-5 and BUG-6 were found.
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

**Delivered.** 208 tests green, 51 of them the pg tier. Contract suite passes
against both stores (46 memory, 51 pg). Soak reproduced all three recorded
scenarios within 12%, zero lane violations; numbers are in `soak.ts`'s header
next to the Phase 11 baseline.

Two framework defects surfaced, both invisible from inside the framework's own
monorepo and both found precisely because this repo consumes core as a package:
BUG-5, core imported `zod` without declaring it, resolving only through
hoisting; and BUG-6, the `testing` barrel eagerly loaded the vitest-dependent
clock, making `makeFakeConnector` unusable outside a vitest worker and so
breaking the soak script F13 had moved here. Both are fixed in the framework and filed
in its `BUG_LOG.md`; core is pinned to `94030e4` on `main` -- the merge of that
fix -- rather than to `e633763`.

The dispatcher gained one seam it did not have in the framework: instance
config is now core's `ResolvedRuntimeConfig` merged with this service's
`ResolvedSchedulingConfig`, looked up through an injectable
`scheduling(instanceId)` and cached per instance and budget. Omit the lookup
and every instance resolves the documented defaults, which is exactly what
core did before the split.

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

**Delivered.** 227 tests green, including the pg tier and six new contract
cases that run against both stores. `InstanceAvailability` carries `batchFree`
and `totalFree`; the dispatcher counts in-flight per class; the claim query
gained a `class_rn` window so batch is cut at its own cap without moving
interactive rows in `rn`. Core did not change.

Both reservation tests were confirmed to fail with the fix reverted, while the
three asserting unchanged behaviour still passed -- a test that passes either
way would have proved nothing here, which is how the original defect hid.

Measured cost, back to back on one box: batch drain falls from 1,803/s to
1,322/s at 50k, 27%. That is the intended trade, not a regression -- the
workload is ~98% batch, so the reserved slots idle and batch runs at 8
concurrent instead of 10. Instances that are batch-dominated should set
`interactiveSliceFraction` to 0, which RFE-1 made mean exactly zero.

BUG-7 was found on the way and fixed here: `**/*.test.ts` was excluded from
every tsconfig, so no test file was ever typechecked. The signature change
above compiled at every call site and failed at runtime as a silently empty
claim. `tsconfig.test.json` now covers them and CI runs `typecheck`.

## Phase P2: wiring module

`src/provisioning/wiring.ts` constructing in order: dispatcher pg pool
(separate from any API pool; small, max 5, `statement_timeout` set),
`OperationStore`, `IgaTokenProvider`, `ApplicationConfigStore`,
`ConnectorRegistry` + loader at the connector bundle directory,
`ConnectorManager`, `MetricsSink` (console until P6), `Dispatcher`.
Export `start()`/`stop()`. `stop()`: stop claiming, drain in-flight up to a
budget, release leases, close pools. Wire into SIGTERM. Data path uses
`ConnectorManager.acquire` only; never loop `initInstance` at boot (rebuilds
eager boot).

`IgaTokenProvider` is the OAuth client-credentials provider settled at P0 —
ported from the framework's `OAuthTokenProvider`, not depended upon. It
refreshes lazily on use inside a 30-second early-expiry margin, so it adds
nothing to `stop()`. `start()` fetches once anyway, purely so bad credentials
fail at deploy time instead of on the first operation that reaches IGA.

Only the IGA-backed `ApplicationConfigStore` needs it; wiring the file store
skips it, which is what keeps this phase testable without a live IGA.

Deployment is a single Docker container (P0). Nothing external restarts this
process, so `start()` must reject on a misconfiguration rather than continue
degraded, and an unhandled rejection anywhere in the claim loop is an outage.

**Accept:** boots with wiring active, no routes; SIGTERM with an in-flight
fake op drains then exits; a bad client secret fails `start()` with the token
endpoint's status in the message rather than surfacing later.

**Delivered.** 252 tests green (was 227), 70 of them the pg tier. `npm run
build`, `typecheck` (both configs), and `lint` all clean. Verified from a
clean `npm ci`, and separately by running the real entrypoint
(`npx tsx src/index.ts`) as its own process and sending it a real SIGTERM —
started, answered, exited within the wait window, no force-kill needed.

Four things turned out underspecified or wrong once building against them,
recorded here rather than left silent:

- **`Dispatcher.stop()` had no bounded-wait parameter.** It was
  `await Promise.allSettled([...this.inFlight])`, unbounded. Extended to
  `stop(opts?: { drainBudgetMs?: number })` rather than wrapped externally in
  `wiring.ts` -- `Dispatcher` never sets an `abortSignal` on an attempt (grep
  confirms zero occurrences), so neither approach can cancel anything, only
  stop waiting for it; extending the component that already owns the
  `inFlight` set keeps the budget testable with the existing
  `MemoryOperationStore`/`FakeConnector` harness and is the only place a real
  future cancellation upgrade could live. Additive: no existing caller passes
  an argument.
- **Nothing calls `ApplicationRegistrar.ensure()`.** `Dispatcher` reads an
  instance's config straight from the registry; an application nothing ever
  registered is invisible to `computeAvailability` -- not rejected, just
  silently never claimed. Registration-on-demand belongs at the admission
  boundary (P4: a route handler calls it, synchronously, before
  `store.enqueue(...)`), which does not exist yet. `wiring.ts` exports
  `ensureApplication(applicationId)` as that hook, both for P4 to call later
  and for this phase's own tests to simulate "an operation named this
  application" before enqueueing directly against the store.
- **`ConnectorManager.shutdown()` (framework code) has no refcount guard.**
  Unlike its own `evict()`, it disposes every live instance unconditionally.
  Plausibly intentional -- the same "caller drains before disposing" contract
  `ApplicationRegistrar.drainLeases()` already assumes -- so this is not filed
  as a framework defect. `stop()` treats it as a contract instead: drain the
  dispatcher, then poll `inFlightCount` through a short second-stage grace
  window before calling `manager.shutdown()`, rather than calling it the
  instant the drain budget gives up waiting.
- **Two real-Postgres test files cannot run concurrently.** Vitest's default
  is to run files in parallel; `test/contract/operation-store.pg.test.ts` and
  the new `test/provisioning/wiring.test.ts` both call `resetOperations()`
  (a `TRUNCATE`) against the *same* database in their own `beforeEach`. Run
  side by side, one file's reset can wipe rows the other is mid-test on --
  which surfaced as "operation was never claimed", a failure that looks like
  a dispatcher defect and is a test-isolation gap. `vitest.config.ts` now sets
  `fileParallelism: false`; the in-memory suites cost nothing to serialize
  alongside, and the whole suite still runs in under ten seconds.

Two implementation choices worth recording alongside those:

- The fixture connector `wiring.test.ts` needs (armed to hang, to exercise
  the bounded drain against a genuinely in-flight attempt) is a small
  **committed** module under `test/fixtures/connectors/fake/`, not generated
  per-test into `os.tmpdir()` the way the framework's own
  `ExternalLoader.test.ts` does it. That fixture imports
  `@governance-connector-framework/core/testing`, and Node's ESM resolution
  for a bare specifier walks up `node_modules` from the *importing file's*
  location -- a tmpdir has no ancestor `node_modules` to find. Living inside
  this repo's tree is what makes the import resolve.
- `wiring.ts` does not export its internal `OperationStore` for the tests (or
  P4) to enqueue through. P4 is expected to build its own `OperationStore`
  over its own pool -- distinct from the dispatcher's, per the "separate from
  any API pool" instruction this phase started from -- so the tests do the
  same: a second pool, opened alongside the dispatcher's own, doubles as both
  the assertion connection and the enqueue path a route handler will
  eventually have.

## Phase P3: verify the schema against the target environment

Rescoped at P0. The original phase proved the schema *works*; that is
Postgres behaviour, not managed-service behaviour, and it is now done — see
below. What is left is the part that is specific to a particular deployment
and cannot be established locally.

**Already done, at P0, against PostgreSQL 16.13 installed from apt:**
`scripts/db-setup.sh` seeds a database and was exercised on all four paths.
Fresh install applies `schema.sql` and creates today's and tomorrow's
partitions. A second run reports the schema current and changes nothing.
`--dry-run` reports without acting. Against a database downgraded to the
pre-Phase-11 shape — no `terminal`, no `not_before`, narrow check
constraints, the old `operations_pending_idx` — the script detects the
absence of `terminal` and applies migration 002 rather than `schema.sql`,
which is the trap the original phase named: every statement in `schema.sql`
is IF NOT EXISTS, so applying it to an old table succeeds and the failure
surfaces later from the claim query. Three seeded rows survived the table
rewrite, `terminal` computed correctly across PENDING/RUNNING/SUCCEEDED, and
the drop gate refused the partition, naming its two non-terminal rows.

Post-conditions the script asserts on every run: `operations` and
`operations_history` exist, `terminal` is `GENERATED ALWAYS`, `not_before`
exists, both partition functions exist, `op_type` admits ADD_VALUES and
REMOVE_VALUES, `status` admits AWAITING_READBACK, `operations_claimable_idx`
exists, and a partition covers today.

**What still needs a real instance**, none of which a local server can answer:

- **Role permissions.** P5 creates partitions from inside the running process
  and calls `drop_operations_partition`. Whether the service's role may
  execute DDL at runtime is a grant question that passes locally as superuser
  and fails in production. Verify with the *service's* role, not an admin one.
- **Connection path.** If a transaction-pooling proxy sits in front,
  `pg_advisory_xact_lock` and `FOR UPDATE SKIP LOCKED` still behave — both are
  transaction-scoped — but session state and server-side prepared statements
  do not survive it. Establish which pooling mode, if any, is in the path.
- **Server version.** The DDL is verified on 16. `gen_random_uuid()` needs 13+
  without pgcrypto; generated columns need 12+. Confirm the target's major.
- **Connection limits.** The dispatcher pool is deliberately small (max 5), so
  this is unlikely to bind, but the instance's limit and any per-user cap
  should be recorded next to that number.
- **Latency.** The claim query is a round trip per batch. Local figures
  overstate throughput; record the delta so P8's numbers are read correctly.

**Accept:** `scripts/db-setup.sh` runs clean against a scratch database on the
target instance **using the service's own role**, and this repo's pg contract
suite passes with that `DATABASE_URL`. Record the server version, the pooling
mode, and the observed round-trip latency here.

**Blocked:** no instance is available. This does not block P1, P1.5, or P2,
all of which run against the local server `scripts/test-pg.sh` provides. P8 is
an integrated soak and needs a real database regardless, so that — not P3 —
is the honest deadline for having one.

## Phase P4: routes

`openapi.yaml` (now owned here for the provisioning surface) wins over this
text.

Auth, settled at P0: every route sits behind a bearer token from the same
OAuth authority the service uses outbound. Port
`packages/websocket/src/security/auth.ts` — JWKS fetch and cache, algorithm
allowlist, `iss`/`aud`/expiry checks, clock skew, replay cache — rather than
writing a second one. Mount it in front of every route including the status
endpoint: an operationId is a capability, and an unauthenticated reader could
enumerate provisioning activity across applications.

The authority is ForgeRock AM and its tokens are JWTs (confirmed from a
sample at P0), so JWKS validation applies and introspection is not needed.
Three details from finding 6 that will otherwise cost time: the issuer string
contains `:443` and is compared exactly; `aud` equals the client id and
cannot distinguish this service, so the required scope carries the
authorization decision; and AM emits `scope` as a JSON array rather than a
space-delimited string.

`openapi.yaml` already declares `bearerAuth` as the global security scheme,
so no change there.

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
search with bounded memory, asserted by observation not vibes. Auth: no token
is 401 on every route including status; a token signed by an unknown key is
401; an expired token is 401; a token whose `iss` omits `:443` is 401 rather
than passing; and a valid token **without** the required scope is 403, which
is the test that matters most while `aud` cannot separate callers.

## Phase P5: partition maintenance in-process

Deployment is a single Docker container (settled at P0), so there is no
CronJob to reject — an in-process timer is the only option, and this phase
carries the whole of partition maintenance with nothing behind it.

Hourly timer in the dispatcher process: ensure today+tomorrow partitions; drop
older-than-retention via `drop_operations_partition` only; whole pass under
`pg_advisory_xact_lock`. A refused drop increments a metric and warn-logs
partition name and row count; the refusal is correct and must be loud
(BUG-2's lesson).

Because nothing else will do this work, a *missing* partition needs a signal
too, not just a refused drop. If the timer dies, the table keeps accepting
inserts until the last partition's day passes and then rejects every one with
"no partition of relation found for row" — an outage whose first symptom is
the enqueue path failing, far from the cause. Emit a gauge for how many days
ahead a partition exists; alert on it reaching zero, not on a log line.

**Accept:** partition with a PENDING row survives and increments the metric;
terminal-only past-retention partition drops; two concurrent passes do the
work once; the days-ahead gauge reflects reality after a pass and after a
deliberately skipped one.

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

Add the IGA block: `IGA_TOKEN_URL`, `IGA_CLIENT_ID`, `IGA_CLIENT_SECRET`, and
optional `IGA_SCOPE` / `IGA_AUDIENCE`. The secret comes from the environment
and is never logged — the framework's redaction helper is the precedent, and
a token endpoint error must not echo the request body. Required only when the
configured store is the IGA-backed one; the file store leaves them unset,
which is what keeps local runs and CI free of credentials.

Add the inbound-auth block: `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`,
`AUTH_REQUIRED_SCOPE`, and the algorithm allowlist. Same ForgeRock AM
authority as the IGA block, opposite direction.

`AUTH_ISSUER` must be the issuer string **verbatim, including `:443`** — see
finding 6. Validate at boot that it parses and that the JWKS URL is on the
same host, and say so plainly if not; a mismatched issuer is otherwise
indistinguishable from a signing problem at request time.

`AUTH_AUDIENCE` is the **caller's** client id — `idmAdminClient` on the QA
tenant, since AM sets `aud` to the client id for client_credentials. Keep
`IGA_CLIENT_ID` different from it so the service's own outbound token is
rejected on the way in; validate at boot that the two differ and warn loudly
if they do not, because that collapse is invisible at request time.

`AUTH_REQUIRED_SCOPE` is **not optional** regardless: it is the authorization
decision when audiences collapse, and defence in depth when they do not.
Default `fr:iga:*` and refuse to boot if empty.

Deployment is a single Docker container, so every setting here arrives as an
environment variable and there is no config map or mounted file to reconcile
against. Validate the whole block at `start()` and refuse to boot on a
failure: nothing will restart the container into a better state, so a
half-configured process that starts anyway is worse than one that does not.

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
a valid value is picked up on the next operation with no restart; the IGA
block is absent without complaint when the file store is configured, and its
absence refuses to boot when the IGA store is; a client secret never appears
in any log line, including the token endpoint's error path.

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
