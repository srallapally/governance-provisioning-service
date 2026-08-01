#!/usr/bin/env bash
#
# Seed a database with the provisioning schema, from nothing or from an
# existing table, and leave it ready for the dispatcher.
#
#   eval "$(bash scripts/test-pg.sh)"     # local throwaway server -> DATABASE_URL
#   bash scripts/db-setup.sh              # seed it
#
#   DATABASE_URL='postgres://...' bash scripts/db-setup.sh   # any other target
#
# Idempotent: safe to run against a database it has already seeded. It decides
# what to do by inspecting the target rather than by being told, because the
# expensive mistake here is applying schema.sql to a database that predates
# Phase 11 -- every statement in it is IF NOT EXISTS, so it succeeds while
# leaving the table without the `terminal` column, and the failure surfaces
# later as "column terminal does not exist" from the claim query.
#
# Flags:
#   --dry-run     report what would be done and change nothing
#   --days N      partitions to create ahead of today (default 1, i.e. tomorrow)
#   --no-verify   skip the post-conditions

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$ROOT/sql/schema.sql"
MIGRATION_002="$ROOT/sql/migrations/002_status_and_optype.sql"

DRY_RUN=0
DAYS_AHEAD=1
VERIFY=1

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)   DRY_RUN=1 ;;
        --days)      DAYS_AHEAD="${2:?--days needs a number}"; shift ;;
        --no-verify) VERIFY=0 ;;
        -h|--help)   sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)           echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

log()  { echo "[db-setup] $*" >&2; }
fail() { echo "[db-setup] ERROR: $*" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set. Run: eval \"\$(bash scripts/test-pg.sh)\""
[ -f "$SCHEMA" ] || fail "missing $SCHEMA"
[ -f "$MIGRATION_002" ] || fail "missing $MIGRATION_002"

command -v psql >/dev/null 2>&1 || fail "psql not found on PATH"

# -X ignores ~/.psqlrc; ON_ERROR_STOP makes a failed statement a failed script
# rather than a warning buried in output.
psql_q() { psql -X -v ON_ERROR_STOP=1 -qtAc "$1" "$DATABASE_URL"; }
psql_f() { psql -X -v ON_ERROR_STOP=1 -q -f "$1" "$DATABASE_URL"; }

psql_q 'SELECT 1' >/dev/null 2>&1 || fail "cannot connect with the supplied DATABASE_URL"
log "connected: database $(psql_q 'SELECT current_database()'), PostgreSQL $(psql_q 'SHOW server_version')"

# ---------------------------------------------------------------------------
# Decide: fresh install, migration, or already current
# ---------------------------------------------------------------------------

HAS_TABLE="$(psql_q "SELECT to_regclass('operations') IS NOT NULL")"
HAS_TERMINAL=f
if [ "$HAS_TABLE" = "t" ]; then
    HAS_TERMINAL="$(psql_q "
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'operations' AND column_name = 'terminal'
        )")"
fi

if [ "$HAS_TABLE" != "t" ]; then
    PLAN="fresh"
    log "no operations table: applying schema.sql"
elif [ "$HAS_TERMINAL" != "t" ]; then
    PLAN="migrate"
    log "operations table predates Phase 11 (no terminal column): applying migration 002"
    log "NOTE: 002 adds a STORED generated column, which rewrites the table under"
    log "      ACCESS EXCLUSIVE. Drain the dispatchers first; it is not safe to run"
    log "      alongside a live claim loop."
else
    PLAN="current"
    log "schema already current"
fi

if [ "$DRY_RUN" = "1" ]; then
    log "dry run: would apply '$PLAN' then create partitions for today +${DAYS_AHEAD}d"
    exit 0
fi

case "$PLAN" in
    fresh)   psql_f "$SCHEMA" ;;
    migrate) psql_f "$MIGRATION_002" ;;
    current) : ;;
esac

# ---------------------------------------------------------------------------
# Partitions
# ---------------------------------------------------------------------------
#
# A range-partitioned table with no partition covering now() rejects every
# insert ("no partition of relation found for row"), so the enqueue path is
# dead until these exist. P5 keeps them rolling forward in-process; this is
# the initial seed.

# create_operations_partition() returns void and is idempotent, so whether it
# did anything has to be observed rather than returned.
partition_exists() {
    psql_q "SELECT to_regclass('operations_' || to_char('${1}'::date, 'YYYYMMDD')) IS NOT NULL"
}

for offset in $(seq 0 "$DAYS_AHEAD"); do
    day="$(psql_q "SELECT (current_date + ${offset})::text")"
    before="$(partition_exists "$day")"
    psql_q "SELECT create_operations_partition('${day}'::date)" >/dev/null
    [ "$(partition_exists "$day")" = "t" ] || fail "partition for ${day} was not created"
    log "partition for ${day}: $([ "$before" = "t" ] && echo "already present" || echo created)"
done

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

if [ "$VERIFY" = "1" ]; then
    check() {
        local label="$1" query="$2"
        if [ "$(psql_q "$query")" = "t" ]; then
            log "  ok   $label"
        else
            fail "post-condition failed: $label"
        fi
    }

    log "verifying"
    check "operations table exists" "SELECT to_regclass('operations') IS NOT NULL"
    check "terminal generated column" "
        SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='operations' AND column_name='terminal'
                         AND is_generated='ALWAYS')"
    check "not_before column" "
        SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='operations' AND column_name='not_before')"
    # to_regprocedure, not to_regproc: only the former parses an argument list.
    check "drop_operations_partition(date)" "SELECT to_regprocedure('drop_operations_partition(date)') IS NOT NULL"
    check "create_operations_partition(date)" "SELECT to_regprocedure('create_operations_partition(date)') IS NOT NULL"
    # conrelid matters: every partition inherits these constraints, so an
    # unqualified lookup by name returns one row per partition and the caller
    # compares against "t\nt\nt".
    check "op_type admits ADD_VALUES/REMOVE_VALUES" "
        SELECT pg_get_constraintdef(oid) LIKE '%ADD_VALUES%'
           AND pg_get_constraintdef(oid) LIKE '%REMOVE_VALUES%'
        FROM pg_constraint
        WHERE conrelid = 'operations'::regclass AND conname = 'operations_op_type_check'"
    check "status admits AWAITING_READBACK" "
        SELECT pg_get_constraintdef(oid) LIKE '%AWAITING_READBACK%'
        FROM pg_constraint
        WHERE conrelid = 'operations'::regclass AND conname = 'operations_status_check'"
    check "claimable index" "
        SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='operations_claimable_idx')"
    check "partition covering today" "
        SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'operations_' || to_char(current_date,'YYYYMMDD'))"
    check "operations_history table" "SELECT to_regclass('operations_history') IS NOT NULL"
fi

log "ready"
