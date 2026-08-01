#!/usr/bin/env bash
#
# Bring up a throwaway PostgreSQL for the integration suite and print the
# DATABASE_URL to export.
#
# There is no Docker in the Claude Code web sandbox, so this drives a server
# installed from apt directly. It is idempotent: if a server is already
# answering on the chosen port it just prints the URL.
#
#   eval "$(bash scripts/test-pg.sh)"   # exports DATABASE_URL
#   npm run test:pg -w @governance-connector-framework/core
#
# Everything except the final `export` line goes to stderr, so the output can
# be eval'd directly.

set -euo pipefail

PGPORT="${PGPORT:-5433}"
PGDB="${PGDB:-gcf_test}"
PGSOCKET="${PGSOCKET:-/tmp}"
PGDATA_DIR="${PGDATA_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.pgdata}"

log() { echo "[test-pg] $*" >&2; }

# `initdb` and `postgres` refuse to run as root. When this script is root --
# which it is in the web sandbox -- everything server-side is run as the
# `postgres` system user instead. Elsewhere it runs as the invoking user.
if [ "$(id -u)" -eq 0 ]; then
  RUN_AS="postgres"
  as_pg() { su "$RUN_AS" -c "$1"; }
else
  RUN_AS="$(id -un)"
  as_pg() { bash -c "$1"; }
fi

find_bindir() {
  if command -v initdb >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return
  fi
  local candidate
  candidate="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$candidate" ] && echo "$candidate"
}

BINDIR="$(find_bindir)"

if [ -z "$BINDIR" ]; then
  log "PostgreSQL not installed; installing from apt"
  if [ "$(id -u)" -eq 0 ]; then
    apt-get update -qq >&2
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >&2
  else
    sudo apt-get update -qq >&2
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >&2
  fi
  BINDIR="$(find_bindir)"
fi

[ -n "$BINDIR" ] || { log "could not locate PostgreSQL binaries after install"; exit 1; }
log "using binaries from $BINDIR"

# Empty host in the URL authority is deliberate: it is what makes the
# `host=` query parameter select a Unix socket. Naming a host there (even
# localhost) wins over the parameter and sends the driver to TCP 5432.
URL="postgres:///${PGDB}?host=${PGSOCKET}&port=${PGPORT}&user=postgres"

if "$BINDIR/pg_isready" -h "$PGSOCKET" -p "$PGPORT" -q 2>/dev/null; then
  log "server already answering on ${PGSOCKET}:${PGPORT}"
else
  if [ ! -s "$PGDATA_DIR/PG_VERSION" ]; then
    log "initialising cluster at $PGDATA_DIR"
    rm -rf "$PGDATA_DIR"
    mkdir -p "$PGDATA_DIR"
    [ "$(id -u)" -eq 0 ] && chown "$RUN_AS" "$PGDATA_DIR"
    # trust auth: this cluster listens on a Unix socket only and holds
    # nothing but disposable test data.
    as_pg "$BINDIR/initdb -D '$PGDATA_DIR' -A trust -U postgres" >&2
  fi

  log "starting server on ${PGSOCKET}:${PGPORT}"
  as_pg "$BINDIR/pg_ctl -D '$PGDATA_DIR' -o '-p $PGPORT -k $PGSOCKET -c listen_addresses=' -l '$PGDATA_DIR/server.log' -w start" >&2
fi

if ! as_pg "$BINDIR/psql -h '$PGSOCKET' -p '$PGPORT' -U postgres -lqt" 2>/dev/null | cut -d'|' -f1 | grep -qw "$PGDB"; then
  log "creating database $PGDB"
  as_pg "$BINDIR/createdb -h '$PGSOCKET' -p '$PGPORT' -U postgres '$PGDB'" >&2
fi

log "ready"
echo "export DATABASE_URL='${URL}'"
