-- OpenBooks forward migration 0641_recurring_schedule_run_limits.
--
-- Seasonal contracts leave whole periods unbilled, and instalment plans end
-- after a fixed number of runs. Two columns bound generation on
-- recurring_schedules: a maximum document count and the exact period dates
-- to skip. The scheduler tick, catch-up runs, and previews treat a skipped
-- date as advanced-past (no document, no counter) and deactivate the
-- schedule once the count is reached, exactly as the end date does.
--
-- Backfill: none. Null max_occurrences means unlimited and an empty
-- skipped_run_ons means nothing skipped, so every existing row behaves as
-- before until an operator sets a limit.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.recurring_schedules
  ADD COLUMN IF NOT EXISTS max_occurrences integer;

ALTER TABLE public.recurring_schedules
  ADD COLUMN IF NOT EXISTS skipped_run_ons date[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (select 1 from pg_constraint where conname = 'recurring_schedules_max_occurrences_range') THEN
    ALTER TABLE public.recurring_schedules
      ADD CONSTRAINT recurring_schedules_max_occurrences_range
      CHECK (max_occurrences IS NULL OR max_occurrences >= 1);
  END IF;
END $$;

COMMENT ON COLUMN public.recurring_schedules.max_occurrences IS
  'Maximum documents this schedule generates. The scheduler tick, catch-up runs, and run-now stop once run_count reaches it and deactivate the schedule, exactly as the end date does. Null means unlimited.';

COMMENT ON COLUMN public.recurring_schedules.skipped_run_ons IS
  'Period dates this schedule never bills. A due occurrence whose date is listed advances past it with no document and no counter, so out-of-season periods stay silent; the dates remain visible in the editor. Empty means nothing skipped.';
