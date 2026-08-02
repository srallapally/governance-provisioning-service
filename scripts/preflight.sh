#!/usr/bin/env bash
#
# Checks the local Docker workflow's prerequisites before you hit them one
# at a time as confusing failures partway through a build or `compose up` --
# a missing Compose feature or a port already in use otherwise surfaces as
# an opaque error from deep inside `docker compose`, not from here.
#
#   bash scripts/preflight.sh              # docker compose up --build workflow
#   bash scripts/preflight.sh --publish    # also check the image-build/publish runbook's extras
#
# Reports every problem found, not just the first (same reasoning as
# auth.ts's validateJwtConfig: one run should say everything that's wrong,
# not make you fix issues one at a time). Hard requirements fail the run
# (exit 1); soft ones (a busy port that might just be your own previous
# `compose up`, tooling only the publish runbook needs) warn and continue.
#
# Flags:
#   --publish   also check git and gcloud (needed by README's "Building and
#               publishing the production image" runbook, not by
#               `docker compose up` itself)

# No -e, unlike db-setup.sh: a failing check here (docker info erroring, a
# missing command) is exactly what this script exists to report and keep
# going past, not a reason to abort before the rest have run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_PUBLISH=0

while [ $# -gt 0 ]; do
    case "$1" in
        --publish) CHECK_PUBLISH=1 ;;
        -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)         echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

FAILURES=0
WARNINGS=0

log()  { echo "[preflight] $*" >&2; }
# "$*", not "$1" -- several call sites below pass a message split across
# multiple quoted arguments for readability; $1 alone would silently drop
# everything after the first.
ok()   { log "  ok   $*"; }
bad()  { log "  FAIL $*"; FAILURES=$((FAILURES + 1)); }
warn() { log "  warn $*"; WARNINGS=$((WARNINGS + 1)); }

# Bash's own /dev/tcp, not nc/lsof -- keeps this script dependency-free on
# the one thing it can't itself verify the presence of.
port_busy() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# ---------------------------------------------------------------------------
# Run from the repo root, with the files this checks for actually present
# ---------------------------------------------------------------------------

for f in Dockerfile docker-compose.yml sql/schema.sql scripts/db-setup.sh; do
    if [ -f "$ROOT/$f" ]; then
        ok "$f present"
    else
        bad "$f missing -- run this from the repo root, or the checkout is incomplete"
    fi
done

# ---------------------------------------------------------------------------
# Docker itself
# ---------------------------------------------------------------------------

if command -v docker >/dev/null 2>&1; then
    ok "docker on PATH ($(docker --version 2>/dev/null))"

    if docker info >/dev/null 2>&1; then
        ok "docker daemon reachable"
    else
        bad "docker daemon not reachable -- is it running? (Docker Desktop, or \`sudo systemctl start docker\`)"
    fi

    if docker compose version >/dev/null 2>&1; then
        ok "docker compose plugin available ($(docker compose version --short 2>/dev/null))"
    else
        bad "docker compose plugin not available -- the legacy standalone docker-compose binary" \
            "is not enough: docker-compose.yml's migrate/app depends_on conditions need Compose v2"
    fi
else
    bad "docker not found on PATH"
fi

# The most direct test of "is this Docker + Compose combination actually
# compatible with this file," not just an abstract version check --
# docker-compose.yml's own depends_on conditions (service_completed_successfully,
# service_healthy) are exactly what would fail here on an old Compose.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    if (cd "$ROOT" && docker compose config -q) 2>/dev/null; then
        ok "docker-compose.yml parses and is understood by this Compose version"
    else
        bad "docker compose config failed against docker-compose.yml -- Compose version too old," \
            "or the file itself doesn't parse; run \`docker compose config\` directly to see why"
    fi
fi

# ---------------------------------------------------------------------------
# Ports docker-compose.yml publishes on the host
# ---------------------------------------------------------------------------

for entry in "3000:app" "5432:postgres" "4180:jwks"; do
    port="${entry%%:*}"
    svc="${entry##*:}"
    if port_busy "$port"; then
        warn "port $port ($svc) is already in use -- fine if that's your own previous" \
             "\`docker compose up\`, otherwise stop whatever's using it first"
    else
        ok "port $port ($svc) is free"
    fi
done

# ---------------------------------------------------------------------------
# The publish runbook's extras (README's "Building and publishing the
# production image") -- not needed for \`docker compose up\`, so these are
# skipped unless asked for.
# ---------------------------------------------------------------------------

if [ "$CHECK_PUBLISH" = "1" ]; then
    if command -v git >/dev/null 2>&1; then
        ok "git on PATH (used to tag images by commit SHA)"
    else
        warn "git not found -- needed for the publish runbook's \`git rev-parse --short HEAD\` tag"
    fi

    if command -v gcloud >/dev/null 2>&1; then
        ok "gcloud on PATH (used for \`gcloud auth configure-docker\`, if pushing to Artifact Registry)"
    else
        warn "gcloud not found -- only needed if the target registry is GCP Artifact Registry;" \
             "any other OCI registry's own auth tooling is a fine substitute"
    fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

log "$FAILURES failure(s), $WARNINGS warning(s)"
if [ "$FAILURES" -gt 0 ]; then
    exit 1
fi
exit 0
