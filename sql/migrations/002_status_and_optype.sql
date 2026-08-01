-- 002_status_and_optype.sql
--
-- Brings an existing operations table up to the Phase 11 status model.
-- Fresh installs get all of this from schema.sql and do not need this file;
-- it exists for deployments already carrying rows.
--
-- Numbering starts at 002 because schema.sql is, in effect, 001: it is applied
-- whole and is idempotent through IF NOT EXISTS. There is no migration runner
-- in this package -- apply this by hand, or through whatever tooling the
-- deployment already uses. It is written to be safe to run twice.
--
--
-- WHAT CHANGES AND WHY
--
-- A new non-terminal status, AWAITING_READBACK, lets a create that timed out
-- wait for its read-back without holding a mutation slot, a connector lease,
-- and its claim. That wait used to be an inline sleep (BUG-1); at the slow
-- target deadlines CP-2 contemplates it removed a slot for about two minutes
-- per timed-out create, so a degraded target converted its own timeouts into
-- reduced drain.
--
-- Terminality becomes a derived column rather than a list repeated at four
-- sites. The drop gate is the reason this matters: it refuses to drop a
-- partition holding non-terminal rows, and had it kept its hand-written
-- allow-list, a partition holding a deferred read-back would have counted as
-- fully terminal and become droppable -- destroying an answer a caller was
-- promised, quietly.
--
-- ADD_VALUES / REMOVE_VALUES are admitted to op_type here so that Phase 12,
-- which teaches the dispatcher to execute them, is code-only.
--
--
-- LOCKING
--
-- Adding a STORED generated column rewrites the table, taking ACCESS EXCLUSIVE
-- for the duration. On a hot table sized to a 24h window this is short, but it
-- is not free: run it in a maintenance window, or drain the dispatchers first.
-- Nothing here is safe to run concurrently with a live claim loop.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Widen the two check constraints
-- ---------------------------------------------------------------------------

ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_status_check;
ALTER TABLE operations ADD CONSTRAINT operations_status_check
    CHECK (status IN (
        'PENDING',
        'RUNNING',
        'AWAITING_READBACK',
        'SUCCEEDED',
        'REJECTED_PRE_DISPATCH',
        'FAILED_CONFIRMED',
        'INDETERMINATE'
    ));

ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_op_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_op_type_check
    CHECK (op_type IN ('CREATE', 'UPDATE', 'DELETE', 'ADD_VALUES', 'REMOVE_VALUES'));

-- ---------------------------------------------------------------------------
-- 2. New columns
-- ---------------------------------------------------------------------------

ALTER TABLE operations ADD COLUMN IF NOT EXISTS not_before timestamptz NULL;

-- Rewrites the table. See the locking note above.
ALTER TABLE operations ADD COLUMN IF NOT EXISTS terminal boolean NOT NULL
    GENERATED ALWAYS AS (
        status NOT IN ('PENDING', 'RUNNING', 'AWAITING_READBACK')
    ) STORED;

-- ---------------------------------------------------------------------------
-- 3. Re-point the indexes at the derived column
-- ---------------------------------------------------------------------------
--
-- The old pending index covered only status = 'PENDING', so it would not serve
-- a claim that also has to find due AWAITING_READBACK rows. Replaced rather
-- than supplemented: two overlapping partial indexes on the hot path cost a
-- write on every status transition for no additional coverage.

DROP INDEX IF EXISTS operations_pending_idx;

CREATE INDEX IF NOT EXISTS operations_claimable_idx
    ON operations (instance_id, status, not_before)
    WHERE NOT terminal;

DROP INDEX IF EXISTS operations_lane_idx;

CREATE INDEX IF NOT EXISTS operations_lane_idx
    ON operations (instance_id, lane_key)
    WHERE NOT terminal;

-- ---------------------------------------------------------------------------
-- 4. Teach the drop gate to use it
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION drop_operations_partition(p_day date)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    part_name text := format('operations_%s', to_char(p_day, 'YYYYMMDD'));
    live_rows bigint;
BEGIN
    IF to_regclass(part_name) IS NULL THEN
        RETURN false;
    END IF;

    EXECUTE format(
        'SELECT count(*) FROM %I WHERE NOT terminal',
        part_name
    ) INTO live_rows;

    IF live_rows > 0 THEN
        RAISE NOTICE 'partition % retained: % non-terminal row(s)', part_name, live_rows;
        RETURN false;
    END IF;

    EXECUTE format('DROP TABLE %I', part_name);
    RETURN true;
END;
$$;

COMMIT;
