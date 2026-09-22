-- OpenBooks forward migration 0258_payment_run_file_created_at.
--
-- AP bank files (NACHA, CPA-005, SEPA) stamp a creation date/time in the
-- header, and the bank keys duplicate-file detection on that header. The
-- file bytes are generated on demand, so stamping wall-clock time at render
-- means every re-download produces a different header: an accidental
-- re-upload of the SAME run then looks like a NEW file and pays every
-- vendor twice. Stamping the run once — the instant its first file is
-- created — and reusing that instant on every later render makes
-- re-downloads byte-identical, so the bank rejects the re-upload instead.
--
-- Backfill: none. Existing runs stamp on their next generation (the writer
-- coalesces), and already-downloaded artifacts keep serving their stored
-- bytes, which the artifact dedupe returns verbatim.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.payment_runs
  ADD COLUMN IF NOT EXISTS file_created_at timestamp with time zone;

COMMENT ON COLUMN public.payment_runs.file_created_at IS
  'Instant the run''s first bank file was created (0258). Stamped once via coalesce on first generation and reused by every later render, so re-downloads reproduce byte-identical files and the bank''s duplicate-file detection still recognizes an accidental re-upload of the same run.';

-- 0258 (appended): billing anchor day-of-month.
--
-- Month-step schedulers advanced the DAY from the already-clamped date, so
-- month-end starts drifted (Jan 31 → Feb 28 → Mar 28 …). Each next date must
-- instead take its day from a stored anchor, clamped per month (Jan 31 →
-- Feb 28 → Mar 31). New rows store the anchor at creation; the schedulers
-- fall back to the schedule's start when it is null.
--
-- Backfill: subscriptions anchor on their start date; recurring schedules
-- anchor on their earliest claimed occurrence (the true first occurrence,
-- which recovers the anchor even for already-drifted rows), else the
-- upcoming next_run_on.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS anchor_day smallint;

ALTER TABLE public.recurring_schedules
  ADD COLUMN IF NOT EXISTS anchor_day smallint;

UPDATE public.subscriptions
   SET anchor_day = extract(day from start_on)::smallint
 WHERE anchor_day IS NULL;

UPDATE public.recurring_schedules rs
   SET anchor_day = coalesce(
         (select extract(day from min(rod.occurrence_on))::smallint
            from public.recurring_occurrence_documents rod
           where rod.schedule_id = rs.id and rod.org_id = rs.org_id),
         extract(day from rs.next_run_on)::smallint)
 WHERE rs.anchor_day IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (select 1 from pg_constraint where conname = 'subscriptions_anchor_day_range') THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_anchor_day_range
      CHECK (anchor_day IS NULL OR (anchor_day >= 1 AND anchor_day <= 31));
  END IF;
  IF NOT EXISTS (select 1 from pg_constraint where conname = 'recurring_schedules_anchor_day_range') THEN
    ALTER TABLE public.recurring_schedules
      ADD CONSTRAINT recurring_schedules_anchor_day_range
      CHECK (anchor_day IS NULL OR (anchor_day >= 1 AND anchor_day <= 31));
  END IF;
END $$;

COMMENT ON COLUMN public.subscriptions.anchor_day IS
  'Day-of-month the billing cadence pins to (0258). Each next bill date advances the year-month and clamps this day into the target month, so month-end starts do not drift. Null behaves as the start date''s day.';

COMMENT ON COLUMN public.recurring_schedules.anchor_day IS
  'Day-of-month the schedule cadence pins to (0258). Each next run date advances the year-month and clamps this day into the target month, so month-end starts do not drift. Null behaves as the next run date''s day.';
