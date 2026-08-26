-- OpenBooks forward migration 0008_scheduler_outbox_terminal_columns.
--
-- Migration-ordering repair (CI-fresh-install blocker): the approved ordinal
-- canonicalization moved 0006_terminal_failure_surfacing to 0035, which placed
-- the scheduler_outbox terminal-failure columns AFTER the lease-fencing
-- backfill (now 0052) that UPDATEs them. Fresh installations therefore failed
-- at the old 0008 with 'column "terminal_failed_at" does not exist'.
--
-- This migration restores ordering by creating those two columns up front,
-- idempotently. 0035 keeps its own ADD COLUMN IF NOT EXISTS statements and
-- remains a no-op here for scheduler_outbox; it still owns the report_runs
-- columns. No data changes; no engine logic changes.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.scheduler_outbox ADD COLUMN IF NOT EXISTS terminal_failed_at timestamp with time zone;
ALTER TABLE public.scheduler_outbox ADD COLUMN IF NOT EXISTS terminal_failed_by text;
