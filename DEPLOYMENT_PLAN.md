# Deployment plan: local Docker → GKE, with HA and DR

A design document, not yet an implementation. It answers how this service
gets from a developer's laptop to a highly-available GKE deployment with a
documented disaster-recovery posture. The local Docker piece
(`Dockerfile`, `docker-compose.yml`) is already built and verified — see
the README's Docker section. Everything below the container image is
**plan, not built**: no k8s manifests exist yet. That's deliberate, per an
explicit decision made before writing this: plan the k8s/HA/DR story first,
build local Docker immediately since it's low-risk and useful regardless of
how the k8s questions resolve.

Three scoping decisions, made before any of this was drafted, not
re-litigated below:

- **Target platform: GKE.** The project already runs on GCP (Cloud SQL).
  GKE gets Workload Identity (no static credentials for DB/secret access),
  Artifact Registry, and Cloud SQL Auth Proxy natively, at no extra
  integration cost.
- **DR scope: single-region resilience now, cross-region documented as a
  future runbook.** Cloud SQL's built-in regional HA (synchronous standby,
  automatic failover) plus PITR backups, and a multi-zone, multi-replica
  app tier. No second region gets built. Matches an early-stage service
  with one real Cloud SQL instance today.
- **Config delivery: connector bundles baked into the image, app configs
  via ConfigMap.** Immutable, versioned deploys for the thing that changes
  rarely and needs a rebuild to change safely (a connector bundle); a
  editable-without-rebuild ConfigMap for the thing that changes per
  environment (which applications are registered, and how).

## The foundational fact this whole plan leans on

Horizontal scaling of the app tier needs no leader election, no singleton
replica, and no coordination beyond what Postgres already provides. Read
directly from the code, not assumed:

- **Claiming** (`OperationStore.claimBatch`, `CLAIM_SQL`) ends in `FOR
  UPDATE OF o SKIP LOCKED` — two replicas racing the same claim query each
  get a disjoint set of rows, by construction. No two replicas can ever
  claim the same operation.
- **The reaper** (`OperationStore.reapStale`) takes `pg_try_advisory_xact_lock`
  before doing anything — a replica that loses the race simply skips that
  pass rather than doing redundant (or conflicting) work.
- **Partition maintenance** (`PartitionMaintainer`) takes a *blocking*
  `pg_advisory_xact_lock`, and its own header comment says why: "two
  replicas racing this should serialize and both see up-to-date state
  afterward, not have one silently do nothing for an hour."

`README.md`'s "single Docker container" framing (from P0) was a
simplifying assumption for getting the first phases shipped, not a
constraint the locking design actually depends on. HA here is "run N
replicas of the same stateless image against the same Postgres," full
stop — no new coordination primitive needs to be invented for this plan to
work.

## Container image

Built and verified (see README's Docker section). `Dockerfile`'s `runtime`
target: `node:22-alpine`, non-root (`USER app`), no dev dependencies,
`HEALTHCHECK` against `/healthz` using Node's own `fetch` (no extra OS
package). Connector bundles get baked in at build time from
`docker/connector-bundles/` (empty by default — see that directory's own
README, and the README's "Building and publishing the production image"
runbook, for how a real build supplies real bundles: they get copied into
that directory before `docker build` runs, not pointed at via a build ARG
— Docker's `COPY` can't reach outside the build context, so there's no
ARG that could point at an external checkout instead).

This same image, unmodified, is what ships to GKE — the `runtime` target
is already production-shaped, not a local-only artifact. `docker-compose.yml`
exists purely for local iteration and is explicitly out of scope as a
production topology model (its own header comment says so).

## Health probes

Already built (not part of this plan's remaining work) — `GET /healthz`
and `GET /readyz`, mounted ahead of `requireJwt()` so neither needs a
bearer token. The split matters for k8s specifically:

- **Liveness → `/healthz`.** Never touches the store. A slow or
  unreachable database should stop a pod receiving traffic, not restart
  it — restarting doesn't fix an unreachable database, and killing a pod
  mid-drain would abandon whatever it had in flight for no benefit.
- **Readiness → `/readyz`.** Makes the cheapest possible round trip to the
  store (`OperationStoreApi.ping()`). A pod that can't reach Postgres
  should stop receiving new traffic immediately, without being killed —
  it can resume the moment connectivity returns.

k8s manifest shape (not yet written, described here for when it is):

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 3000 }
  initialDelaySeconds: 5
  periodSeconds: 10
readinessProbe:
  httpGet: { path: /readyz, port: 3000 }
  initialDelaySeconds: 2
  periodSeconds: 5
  failureThreshold: 3
```

No `startupProbe` planned — the process has nothing slow to initialize
(no cache warm, no large in-memory load); `loadExternalConnectors` and
`start()` both run synchronously before the HTTP server starts listening,
so "listening" already implies "ready to attempt readiness."

## Connectivity to Cloud SQL

**Recommended: Cloud SQL Auth Proxy as a sidecar container**, not a direct
private-IP connection from the app container. Three reasons:

1. It presents a plain local Postgres endpoint (`127.0.0.1:5432`,
   `sslmode=disable`) to the app — the exact `sslmode=require` /
   `uselibpqcompat=true` workaround P3 needed for a direct connection to a
   Cloud SQL instance whose CA isn't in the public trust store disappears
   entirely. The proxy handles TLS and the certificate trust problem
   itself.
2. IAM database authentication becomes possible without ever storing a DB
   password: the proxy authenticates to Cloud SQL using the pod's Workload
   Identity, and Cloud SQL trusts that identity directly. `DATABASE_URL`'s
   only remaining secret-shaped part is a database *name*, not a
   credential.
3. It's the GCP-documented, GCP-supported pattern for GKE → Cloud SQL,
   which matters for anyone operating this later who isn't the person who
   built it.

The cost: one more container per pod, a small amount of extra memory, and
one more thing in the pod's readiness chain (the proxy needs to be up
before the app's `/readyz` can succeed — the proxy container's own startup
is fast and this is a standard, well-understood ordering problem in GKE,
not a new one).

**Alternative considered, not recommended by default:** Private Service
Connect / direct private IP. Removes the sidecar, but brings back the TLS
trust problem P3 already worked around once, and pushes IAM/password
management back onto the app. Worth revisiting only if the sidecar's
resource cost turns out to matter at the replica counts this service
actually runs at.

## Secrets and configuration

| What | How | Why |
|---|---|---|
| DB connectivity | Cloud SQL Auth Proxy sidecar, IAM DB auth via Workload Identity | No stored DB password at all |
| `JWT_JWKS_URI` / `JWT_EXPECTED_ISS` / `JWT_EXPECTED_AUD` | ConfigMap (not secret — URLs and identifiers, not credentials) | Editable per environment without a rebuild |
| App configs (`APP_CONFIG_DIR`) | ConfigMap, one key per `${applicationId}.json`, mounted as a volume | Decided above: editable without a rebuild, unlike bundles |
| Connector bundles (`CONNECTOR_BUNDLE_DIR`) | Baked into the image at build time | Decided above: immutable, versioned, no runtime volume |
| `IGA_CLIENT_SECRET` (only if `APP_CONFIG_STORE=iga` is ever adopted) | GCP Secret Manager via the Secret Manager CSI driver, mounted as a volume | The one genuine long-lived credential this service would hold; not applicable today since `file` mode was the explicit choice |

Workload Identity backs all of this: the GKE service account maps to a GCP
service account with exactly the IAM roles needed (Cloud SQL Client for
the proxy, Secret Manager Secret Accessor only if `iga` mode is ever
adopted) — no key files, nothing to rotate by hand.

## Deployment topology

- **Deployment**, not StatefulSet — the app holds no local state; every
  fact about an operation lives in Postgres. `replicas: 3` as a starting
  point (below is fewer than the zones a regional cluster typically
  spans; matches "always at least one pod survives a single zone's node
  pool going away" without over-provisioning before there's traffic data
  to size against).
- **`topologySpreadConstraints`** across zones (`topologyKey:
  topology.kubernetes.io/zone`, `maxSkew: 1`) so replicas don't collapse
  onto one zone by scheduler coincidence.
- **`PodDisruptionBudget`** (`minAvailable: 2` at `replicas: 3`) — survives
  a voluntary node drain (cluster upgrade, node pool resize) without ever
  going to zero capacity. Involuntary loss (a zone outage) isn't something
  a PDB can prevent, which is exactly why zone spread is the thing doing
  the real work there.
- **Rolling update** (`maxUnavailable: 0, maxSurge: 1`) — never drops
  capacity during a deploy, at the cost of briefly running one extra pod.
  `terminationGracePeriodSeconds` must exceed `drainBudgetMs +
  shutdownGraceMs` (wiring's own defaults: 8000 + 2000 = 10000ms) plus
  headroom for the proxy sidecar and kubelet overhead — **60s** is a
  reasonable floor, generous relative to the defaults. `src/index.ts`
  already does the right thing on `SIGTERM`: close the HTTP server first
  (nothing new can enqueue), then drain the dispatcher, then exit —
  nothing about this plan changes that; k8s just needs to give it enough
  time.
- **Service**: `ClusterIP`, fronted by whatever this GKE cluster's
  standard ingress pattern is (not specified here — an org-wide choice,
  not something this plan should invent unilaterally).
- **HPA**: CPU-based to start (`targetCPUUtilizationPercentage`, a
  reasonable default like 70). A backlog-depth-based custom metric
  (`gcf.operations.backlog_depth`, already emitted per instance/priority —
  see `src/ops/metrics.ts`) would be a better signal for *this* workload
  specifically, since claim throughput is really what should drive
  scaling, not CPU. That needs P6 (metrics binding, currently Backlog) to
  land first — CPU-based HPA now, revisit once P6 does.

## Database HA

Cloud SQL's own regional HA (synchronous standby in a second zone,
automatic failover, typically well under two minutes) is the entire DB-tier
HA story for this plan — nothing in this service needs to know a failover
happened. `pg`'s connection pool reconnects on the next query after the
new primary is reachable; in-flight attempts during the failover window
fail and either retry (per the dispatcher's existing backoff) or land in
the reaper's stranded-`RUNNING`-row recovery path, exactly the same as any
other transient connection loss this service already tolerates (see
`stop()`'s docstring in `Dispatcher.ts` for the closed-pool case this same
class of tolerance was built for).

## Disaster recovery

Per the scoping decision above: **built now** is Cloud SQL's regional HA
(covers a zone loss) plus automated backups with point-in-time recovery
(covers data corruption or an operator mistake, not infrastructure loss).
**Documented, not built:** a cross-region posture, as a future runbook
outline —

1. A Cloud SQL cross-region read replica, kept warm in a second region.
2. On a declared regional disaster: promote the replica to a standalone
   primary (a manual, deliberate action — Cloud SQL does not auto-promote
   across regions, correctly, since that decision has real consequences
   and shouldn't be automatic).
3. Redeploy this service's GKE workload into the second region's cluster
   (or fail over to one already running there in passive/scaled-to-zero
   form), pointed at the newly-promoted primary.
4. Redirect traffic (DNS or a global load balancer, depending on what
   fronts this service) to the second region.

RTO/RPO for that path are not estimated here — they depend on decisions
(warm standby app tier vs. cold, DNS TTL, who's paged and how fast) that
are organizational, not architectural, and shouldn't be guessed at in this
document. Building the above is future work, gated on an actual RTO/RPO
requirement showing up, not spec'd speculatively now.

## Migrations

**Not a per-pod initContainer.** N replicas starting simultaneously would
each try to apply DDL concurrently — `schema.sql`'s `IF NOT EXISTS`
statements make that survivable, not race-free (`scripts/db-setup.sh`'s own
header comment already warns about the "applies successfully but leaves
the table wrong" failure mode this could invite under real concurrency).
Migrations run as a **single pre-deploy Job**, before the new Deployment
revision rolls out — a CI pipeline step or a Helm pre-upgrade hook, not yet
chosen (whichever this org's existing GKE deployments already use, so this
service doesn't invent a second pattern). The Job runs
`scripts/db-setup.sh` unmodified — the same script `docker-compose.yml`'s
`migrate` service already runs, and the same one a real operator runs
today. Its own idempotency (inspects the target rather than assuming
state) makes it safe to run on every deploy, including ones where nothing
schema-related changed.

## CI/CD (sketch, not built)

Extend `.github/workflows/ci.yml` with a build-and-push stage, gated behind
the existing `build-test` job:

- Build the `runtime` target, tag by commit SHA (and `latest` on `main`),
  push to Artifact Registry.
- A separate deploy step (manifest apply, whichever of kustomize/Helm this
  org standardizes on) is left unscoped here deliberately — it depends on
  manifests that don't exist yet (see "What ships now vs. later" below)
  and on this org's existing GKE rollout conventions, neither of which
  this plan should invent unilaterally.

## What ships now vs. later

**Done:** `Dockerfile`, `docker-compose.yml`, `/healthz`/`/readyz`. This
document.

**Explicitly not done, and not part of this plan's PR:** any k8s manifest
(Deployment, Service, ConfigMap, HPA, PDB), the Cloud SQL Auth Proxy
sidecar wiring, the migration Job, CI/CD's build-and-push stage. All of
that is real implementation work this document sets up for, not
implicitly authorizes — each is its own reviewable unit, same discipline
as every phase in `PROVISIONING_SERVICE_PLAN.md`.

## Open questions, not decided here

Left open deliberately — organizational choices, not architectural ones,
and answering them speculatively would just be guessing:

- Ingress pattern (this org's existing GKE ingress/Gateway convention,
  whatever it is) and whether this service is internet-facing or
  internal-only.
- Helm chart vs. plain kustomize manifests.
- Whether the Cloud SQL Auth Proxy sidecar's resource cost ever becomes
  worth trading for Private Service Connect at this service's real replica
  counts.
- An actual RTO/RPO target, which is what would turn the DR runbook above
  from "documented" into "built."
