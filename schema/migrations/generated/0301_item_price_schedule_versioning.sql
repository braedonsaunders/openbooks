-- OpenBooks forward migration 0301_item_price_schedule_versioning.
--
-- Item price schedules could be rewritten or deleted in place: PATCH updated
-- the effective-dated row and reinserted its breaks, DELETE removed it
-- outright, while resolveItemPrice reads those same live rows for any onDate
-- — so an admin could silently reprice already-booked transactions with no
-- successor, no reason and no retained prior version, and two editors raced
-- with no concurrency fence (PRC2 and PRC3).
--
-- Schedules gain the house revision counter (PATCH and DELETE compare the
-- caller-echoed revision under the row lock and refuse stale writers with a
-- reload remedy), a supersedes link so a history-touching change keeps the
-- prior version as a retained inactive row instead of overwriting it, and a
-- change-reason column so the reason a correction or end-dating names is
-- stored on the row as well as in the audit log. Prospective successors
-- end-date the predecessor and insert the new window; reasoned corrections
-- of an already-effective period insert a new version over the same window
-- and retire the old row; resolution keeps reading the version effective on
-- the transaction date, so it needs no change.
--
-- No data change: existing rows start at revision 0 with no predecessor and
-- no reason. Uses ordinal 0301 (0298 belongs to the g29 rate-profile lane).
--
-- Staged build (U12): each validated CHECK and the self-referential foreign
-- key would scan the schedule history while holding the ALTER TABLE lock.
-- Every guard arrives NOT VALID (a short lock that still enforces every new
-- write — safe here because existing rows start at revision 0 with no
-- predecessor and no reason, so none can violate) and a later statement
-- VALIDATEs it under a lock that blocks neither reads nor writes. Each step
-- is replay-safe: every ADD is guarded on pg_constraint and every VALIDATE
-- runs only while its constraint is unvalidated, so a retry treats an
-- already-validated guard as done. The end state is identical to the
-- validated build: the same names, expressions and references, validated.
-- No statement here needs CONCURRENTLY, so the file stays inside the
-- tracked transaction.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.item_price_schedules
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE public.item_price_schedules
  ADD COLUMN IF NOT EXISTS supersedes_id uuid;
ALTER TABLE public.item_price_schedules
  ADD COLUMN IF NOT EXISTS change_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_revision_nonnegative'
  ) THEN
    ALTER TABLE public.item_price_schedules
      ADD CONSTRAINT item_price_schedule_revision_nonnegative CHECK (revision >= 0)
      NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_revision_nonnegative'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.item_price_schedules
      VALIDATE CONSTRAINT item_price_schedule_revision_nonnegative;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_reason_present'
  ) THEN
    ALTER TABLE public.item_price_schedules
      ADD CONSTRAINT item_price_schedule_reason_present
      CHECK (change_reason IS NULL OR char_length(btrim(change_reason)) > 0)
      NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_reason_present'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.item_price_schedules
      VALIDATE CONSTRAINT item_price_schedule_reason_present;
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_supersedes_fk'
  ) THEN
    ALTER TABLE public.item_price_schedules
      ADD CONSTRAINT item_price_schedule_supersedes_fk
      FOREIGN KEY (org_id, supersedes_id) REFERENCES public.item_price_schedules (org_id, id)
      NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.item_price_schedules'::regclass
       AND conname = 'item_price_schedule_supersedes_fk'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.item_price_schedules
      VALIDATE CONSTRAINT item_price_schedule_supersedes_fk;
  END IF;
END
$$;
