-- OpenBooks forward migration 0337_hrm_absence_day_unique.
--
-- Two concurrent recordAbsence POSTs for the same employment and date both
-- pass the count==0 check in engine/src/hrm/attendance.ts and both insert
-- recorded rows. Only a NON-unique index exists
-- (hrm_absences_employment_day), so the calendar nets double hours for the
-- day. The application check cannot arbitrate the READ COMMITTED race
-- between two concurrent writers — only storage can.
--
-- Storage now refuses a second live row per (org, employment, day). The
-- partial predicate is the whole domain rule, and it was already written
-- down in code: cancelLeaveRequest's comment names "the request-day unique"
-- and "the recorded-day unique" that "skips rows with reversal_of set" —
-- prose asserting a guarantee about a mechanism that was never built. This
-- file builds it:
--
--   WHERE (reversal_of IS NULL AND NOT is_pre_guard_legacy)
--
-- Reversal rows (reversal_of set, written by cancellation with negative
-- hours that net the day out) must stay insertable alongside the row they
-- reverse, or cancelling would collide with its own evidence. Request rows
-- and recorded rows share the one live row per day: recordAbsence already
-- refuses a recording wherever ANY non-reversed row covers the day, and
-- approved requests never overlap (assertNoApprovedOverlap, re-validated
-- under the row lock at decide time). Partial-day detail lives in hours,
-- never in a second row, so the unique index cannot forbid anything legal.
--
-- Staged build (0293 precedent): the guard is a UNIQUE index over a
-- populated table, so building it inside the tracked transaction would hold
-- the ALTER TABLE lock for the whole index build. The file declares
-- `-- openbooks: no-transaction` and the runner executes it statement by
-- statement: the index builds with CREATE UNIQUE INDEX CONCURRENTLY, which
-- takes no blocking lock. ADD CONSTRAINT ... UNIQUE USING INDEX cannot
-- attach a partial index — PostgreSQL refuses expression and partial
-- indexes there — so enforcement lives on the standalone unique index
-- itself: a duplicate insert still fails with a unique violation naming
-- hrm_absences_no_double_record, and the engine maps 23505 to the same
-- named refusal the count check raises. The contract that makes a mid-file
-- failure retry-safe: every statement is idempotent (IF NOT EXISTS
-- throughout, the classify block re-runnable and the provenance insert
-- keyed so replays converge), and the DO block up front drops this file's
-- own INVALID index — a failed CONCURRENTLY build leaves one behind, and
-- IF NOT EXISTS would otherwise skip the name forever, silently keeping the
-- missing guard. Plain (non-concurrent) DROP inside the DO block is safe:
-- an INVALID index answers no query, so its brief exclusive lock contends
-- with nothing.
--
-- Legacy preservation: duplicate live rows predate the guard and absence
-- rows carry no delete path — nothing can remove one, and the upgrade must
-- not silently delete absence history. The classify block marks every
-- member of a duplicate group with is_pre_guard_legacy, and the unique
-- index covers only unmarked rows, so all new writes (which default to
-- unmarked) stay fully guarded while the double-counted day stands as
-- evidence. This migration records the same rows in
-- upgrade_legacy_provenance; the preflight names that notice. There is no
-- remediable shape to refuse: no operator action can un-record a row, so
-- the preflight reports (notice) but never blocks.
--
-- This file carries no lock_timeout of its own (refused for ordinals above
-- 0251 by check-migration-headers); the runner's bound governs. On a fresh
-- install all of this replays over empty tables in milliseconds.

-- openbooks: no-transaction

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Exemption marker for pre-guard duplicate-day history. New writes default
-- to unmarked and stay fully guarded.
ALTER TABLE public.hrm_absences
  ADD COLUMN IF NOT EXISTS is_pre_guard_legacy boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.hrm_absences.is_pre_guard_legacy IS
  'True for absence rows that predate the 0337 day guard and share their (employment, day) with another live row. Exempt from the duplicate-day unique index and preserved as evidence: absence rows carry no delete path, so the double-counted day stands. Never set on new writes.';

DO $classify$
DECLARE
  grandfathered integer;
BEGIN
  -- Every member of a duplicate live group is preserved as evidence and
  -- marked. No operator action can un-record a row, so nothing here raises:
  -- the preflight reports these groups as a notice and this block records
  -- their provenance below.
  WITH dup_members AS (
    SELECT a.id
      FROM public.hrm_absences a
     WHERE a.reversal_of IS NULL
       AND NOT a.is_pre_guard_legacy
       AND EXISTS (
         SELECT 1
           FROM public.hrm_absences s
          WHERE s.org_id = a.org_id
            AND s.employment_id = a.employment_id
            AND s.on_date = a.on_date
            AND s.reversal_of IS NULL
            AND s.id <> a.id
       )
  )
  UPDATE public.hrm_absences a
     SET is_pre_guard_legacy = true
    FROM dup_members d
   WHERE a.id = d.id AND NOT a.is_pre_guard_legacy;
  GET DIAGNOSTICS grandfathered = ROW_COUNT;
  IF grandfathered > 0 THEN
    RAISE NOTICE '0337: % hrm_absences row(s) share their (employment, day) with another live row and predate the guard; the double-counted day stands — grandfathered legacy.', grandfathered;
  END IF;

  -- Provenance for the preserved rows, keyed so replays converge. ON
  -- CONFLICT DO NOTHING is justified here and only here: the registry key
  -- IS the row identity, so a replayed backfill converges on the same rows
  -- rather than duplicating evidence.
  INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
  SELECT a.org_id, '0337_hrm_absence_day_unique', 'hrm_absences', a.id,
         format('duplicate live absence for employment %s on %s predates the 0337 day guard; calendar nets the combined hours',
                a.employment_id, a.on_date)
    FROM public.hrm_absences a
   WHERE a.is_pre_guard_legacy
     AND NOT EXISTS (
       SELECT 1 FROM public.upgrade_legacy_provenance p
        WHERE p.org_id = a.org_id
          AND p.migration = '0337_hrm_absence_day_unique'
          AND p.table_name = 'hrm_absences'
          AND p.row_id = a.id
     )
  ON CONFLICT DO NOTHING;
END;
$classify$;

-- Retry safety: drop our own INVALID index before rebuilding. A failed
-- CONCURRENTLY build leaves the name present but unusable, and IF NOT
-- EXISTS below would then skip the name forever.
DO $$
DECLARE
  idx text;
BEGIN
  FOR idx IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid
       AND c.relname IN ('hrm_absences_no_double_record')
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx);
  END LOOP;
END
$$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS hrm_absences_no_double_record
  ON public.hrm_absences USING btree (org_id, employment_id, on_date)
  WHERE (reversal_of IS NULL AND NOT is_pre_guard_legacy);

COMMENT ON INDEX public.hrm_absences_no_double_record IS
  'One live row per (org, employment, day). Two concurrent recordings used to both pass the application count check and double-count the day; reversal rows (reversal_of set) stay insertable alongside the row they reverse. Rows marked is_pre_guard_legacy predate the guard and are preserved as evidence (0337, provenance in upgrade_legacy_provenance).';
