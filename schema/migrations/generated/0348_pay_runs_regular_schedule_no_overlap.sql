-- OpenBooks forward migration 0348_pay_runs_regular_schedule_no_overlap.
--
-- Serialize regular-run creation on the schedule row in the application and
-- enforce the same inclusive period invariant for every database writer.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE public.pay_runs
  ADD CONSTRAINT pay_runs_regular_schedule_no_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    pay_schedule_id WITH =,
    daterange(period_start, period_end, '[]') WITH &&
  )
  WHERE (run_type = 'regular' AND run_status <> 'voided');

COMMENT ON CONSTRAINT pay_runs_regular_schedule_no_overlap ON public.pay_runs IS
  'Only one live regular run may cover each day for an organization and schedule; bonus, termination, retro, and voided runs are not constrained.';
