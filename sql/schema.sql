-- sql/schema.sql
--
-- Durable operation table for asynchronous provisioning mutations.
--
-- Target: PostgreSQL 13+ (Cloud SQL). gen_random_uuid() is built in from 13;
-- on 12 and below, `create extension pgcrypto` first.
--
--
-- RETENTION
--
-- The hot table holds a 24 hour resolution window by default, tunable per
-- deployment. It is range-partitioned by created_at with one partition per
-- day, so ageing data out is a DETACH/DROP rather than a bulk DELETE -- a
-- delete of that volume would leave the table bloated and vacuum chasing it.
--
-- Dropping a partition is gated on it containing zero non-terminal rows.
-- A PENDING or RUNNING row in a partition about to be dropped is an operation
-- the caller was promised an answer for, and dropping it destroys that answer
-- with no trace. Use drop_operations_partition(), which enforces the gate and
-- refuses rather than cascading.
--
-- Because the window is short, the hot table is not the forensic record.
-- Deployments that need payload-level audit MUST export attrs/result to GCS
-- before the partition ages out; after 24 hours the slim history row is all
-- that remains, and it deliberately carries no payload.
--
--
-- WHY THE PRIMARY KEY IS (id, created_at)
--
-- PostgreSQL requires every unique or primary key on a partitioned table to
-- include the partition key, so `id` alone cannot be the primary key here.
-- id is still globally unique in practice -- it is a v4 UUID -- and callers
-- address operations by id alone. The composite key is a storage-engine
-- requirement, not part of the addressing model.

-- ---------------------------------------------------------------------------
-- operations: the hot table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS operations (
    id               uuid        NOT NULL DEFAULT gen_random_uuid(),

    instance_id      text        NOT NULL,
    object_class     text        NOT NULL,
    op_type          text        NOT NULL,
    priority         text        NOT NULL DEFAULT 'batch',
    status           text        NOT NULL DEFAULT 'PENDING',

    -- Serialization key. Operations sharing a lane_key never run concurrently
    -- against the same instance. CREATE keys on the client-supplied naming
    -- attribute (the Uid does not exist yet); UPDATE and DELETE key on the Uid.
    lane_key         text        NOT NULL,

    uid              text        NULL,
    name_attr_value  text        NULL,

    -- Request payload and terminal result. result holds the target-minted Uid
    -- and the returned ConnectorObject on a successful create; that Uid is the
    -- one piece of it that survives into history.
    attrs            jsonb       NULL,
    result           jsonb       NULL,
    error_code       text        NULL,

    attempt_count    integer     NOT NULL DEFAULT 0,

    created_at       timestamptz NOT NULL DEFAULT now(),
    claimed_at       timestamptz NULL,
    finalized_at     timestamptz NULL,

    idempotency_key  text        NOT NULL,

    -- Earliest time this row may be claimed again. Set when an operation is
    -- deferred rather than executed -- currently only the create read-back
    -- wait, which used to be an inline sleep holding a mutation slot.
    not_before       timestamptz NULL,

    -- Terminality, derived once instead of enumerated at every use site.
    --
    -- Four places previously spelled out the non-terminal statuses by hand:
    -- the drop gate, the claim index, the lane index, and the status check.
    -- Adding a status meant remembering all four, and forgetting the drop gate
    -- would have let a partition holding live work be dropped -- silently, and
    -- in the direction of losing an answer a caller was promised. Deriving it
    -- makes that class of mistake unrepresentable.
    terminal         boolean     NOT NULL
                     GENERATED ALWAYS AS (
                         status NOT IN ('PENDING', 'RUNNING', 'AWAITING_READBACK')
                     ) STORED,

    CONSTRAINT operations_pkey PRIMARY KEY (id, created_at),

    CONSTRAINT operations_op_type_check
        CHECK (op_type IN ('CREATE', 'UPDATE', 'DELETE', 'ADD_VALUES', 'REMOVE_VALUES')),

    CONSTRAINT operations_priority_check
        CHECK (priority IN ('interactive', 'batch')),

    CONSTRAINT operations_status_check
        CHECK (status IN (
            'PENDING',
            'RUNNING',
            'AWAITING_READBACK',
            'SUCCEEDED',
            'REJECTED_PRE_DISPATCH',
            'FAILED_CONFIRMED',
            'INDETERMINATE'
        ))
) PARTITION BY RANGE (created_at);

-- Claim path. Partial so the index holds only the working set: PENDING rows
-- are a small and roughly constant fraction of the table, while the terminal
-- rows that dominate it never appear here at all.
CREATE INDEX IF NOT EXISTS operations_claimable_idx
    ON operations (instance_id, status, not_before)
    WHERE NOT terminal;

-- Lane serialization. Answers "which lanes are busy for this instance" without
-- touching terminal rows.
CREATE INDEX IF NOT EXISTS operations_lane_idx
    ON operations (instance_id, lane_key)
    WHERE NOT terminal;

-- Idempotent enqueue lookup.
--
-- This index is NOT unique on idempotency_key alone, and cannot be: a unique
-- index on a partitioned table must contain the partition key, and
-- (idempotency_key, created_at) would only collide on an identical timestamp,
-- which is no constraint at all. Enqueue therefore serializes on a transaction
-- level advisory lock keyed by the idempotency key and does a lookup before
-- inserting. See OperationStore.enqueue.
CREATE INDEX IF NOT EXISTS operations_idempotency_idx
    ON operations (idempotency_key);

-- ---------------------------------------------------------------------------
-- operations_history: the slim permanent record
-- ---------------------------------------------------------------------------
--
-- Written on finalize, in the same transaction that sets the terminal status.
-- Not partitioned: it is narrow, append-only, and never dropped.
--
-- Deliberately carries no attrs and no result blob. It keeps the Uid, because
-- a create's target-minted Uid is the one fact that must outlive the hot row
-- -- without it a successful create becomes unlinkable to the account it made.

CREATE TABLE IF NOT EXISTS operations_history (
    id            uuid        NOT NULL PRIMARY KEY,
    instance_id   text        NOT NULL,
    object_class  text        NOT NULL,
    op_type       text        NOT NULL,
    status        text        NOT NULL,
    uid           text        NULL,
    error_code    text        NULL,
    created_at    timestamptz NOT NULL,
    finalized_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS operations_history_instance_idx
    ON operations_history (instance_id, finalized_at);

CREATE INDEX IF NOT EXISTS operations_history_uid_idx
    ON operations_history (instance_id, uid)
    WHERE uid IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Partition management
-- ---------------------------------------------------------------------------

-- Create the daily partition covering p_day, if absent. Idempotent, so it is
-- safe to call from every replica on a schedule.
CREATE OR REPLACE FUNCTION create_operations_partition(p_day date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    part_name text := format('operations_%s', to_char(p_day, 'YYYYMMDD'));
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF operations FOR VALUES FROM (%L) TO (%L)',
        part_name, p_day, p_day + 1
    );
END;
$$;

-- Drop the daily partition covering p_day, but only if every row in it has
-- reached a terminal status.
--
-- Returns true if the partition was dropped, false if it was held back or was
-- never there. Refusing is the correct outcome, not an error: a non-terminal
-- row means an operation is still in flight or was claimed by a dispatcher
-- that died, and either way it needs resolution before its record disappears.
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
