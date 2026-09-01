-- OpenBooks forward migration 0085_sync_run_connection_nullable.
--
-- A connection may be removed while retaining its sync-run history.  The
-- baseline foreign key already uses ON DELETE SET NULL, but connection_id was
-- still NOT NULL, making the referential action fail at commit.  Make the
-- child column nullable so deletion can detach historical runs safely.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.sync_runs
  ALTER COLUMN connection_id DROP NOT NULL;

COMMENT ON COLUMN public.sync_runs.connection_id IS
  'Connection that produced this run; NULL preserves run history after the connection is deleted.';
