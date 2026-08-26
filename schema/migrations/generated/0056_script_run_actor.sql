-- OpenBooks forward migration 0056_script_run_actor.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: the statement tolerates re-execution.
--
-- The script runners used to write actorless script_runs rows: a manual "Run
-- now" pressed by an authenticated admin was indistinguishable from a cron
-- tick, and any ob.journal.create draft it made went into documents with
-- created_by NULL (system provenance) even though a real, permission-gated
-- human had authorized the operation. This column carries WHO triggered each
-- run — the engine's established convention for attribution:
--
--   * created_by = a users.id  → an interactive trigger ("Run now", endpoint
--     invocations); the runner re-resolves it against users before executing,
--     so only real users of the owning org can ever be stamped.
--   * created_by IS NULL       → system automation (cron ticks). Per the
--     engine-wide provenance rule this is explicit "the system wrote this",
--     never an unknown author; scheduled occurrence ledger rows additionally
--     record the scheduler identity in their logs.
--
-- No backfill: historical rows were genuinely unattributed system/unknown
-- runs and rewriting them would fabricate evidence. New columns on existing
-- tables need no index until a query pattern asks for one.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.script_runs ADD COLUMN IF NOT EXISTS created_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_description
     WHERE objoid = 'public.script_runs'::regclass
       AND objsubid = (
         SELECT attnum FROM pg_catalog.pg_attribute
          WHERE attrelid = 'public.script_runs'::regclass AND attname = 'created_by')
  ) THEN
    COMMENT ON COLUMN public.script_runs.created_by IS
      'openbooks:actor provenance — interactive triggers persist users.id; NULL means the system triggered this run';
  END IF;
END
$$;
