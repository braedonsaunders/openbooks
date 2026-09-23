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

ALTER TABLE public.item_price_schedules
  ADD CONSTRAINT item_price_schedule_revision_nonnegative CHECK (revision >= 0);
ALTER TABLE public.item_price_schedules
  ADD CONSTRAINT item_price_schedule_reason_present
  CHECK (change_reason IS NULL OR char_length(btrim(change_reason)) > 0);
ALTER TABLE public.item_price_schedules
  ADD CONSTRAINT item_price_schedule_supersedes_fk
  FOREIGN KEY (org_id, supersedes_id) REFERENCES public.item_price_schedules (org_id, id);
