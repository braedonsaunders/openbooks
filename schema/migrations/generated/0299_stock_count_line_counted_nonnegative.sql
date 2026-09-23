-- OpenBooks forward migration 0299_stock_count_line_counted_nonnegative.
--
-- A physical count is never negative, but stock_count_lines.counted_quantity
-- carried no CHECK and recordCountedQuantity checked width and scale only.
-- A count of -1 was accepted, reviewed, and posted as a negative variance,
-- and with allow_negative_inventory the position itself could rest at -1
-- while the count read posted — a negative observation with no physical
-- meaning. Negatives are never meaningful here: an empty bin counts 0, and
-- a correction re-records the observation (or opens a new count once
-- posted), it does not go below zero.
--
-- Storage now refuses a negative counted_quantity (NULL stays legal: an
-- uncounted line). The engine preflights the same gate at record and at
-- variance math with a remedy-naming refusal; only storage can arbitrate a
-- writer that bypasses the engine, which is why the guard lives here as
-- well as there.
--
-- Staged build (U11): a validated CHECK scans every row while holding the
-- ALTER TABLE lock, so the constraint arrives NOT VALID (a short lock that
-- still enforces every new write) and a later statement VALIDATEs it under
-- SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes. Both steps
-- are replay-safe: the ADD is guarded on pg_constraint and the VALIDATE runs
-- only while the constraint is unvalidated, so a retry treats an
-- already-validated guard as done. No statement here needs CONCURRENTLY, so
-- the file stays inside the tracked transaction.
--
-- Legacy preservation (U14): the historical bug already posted. Lines on a
-- posted or cancelled count are immutable — the engine refuses their edit
-- and their count's cancellation alike — so "re-record the true count" is
-- not an executable remedy for them, and a direct SQL edit would falsify
-- the observation while leaving its movement and GL history unexplained.
-- Those rows are preserved as evidence: the classify block marks posted and
-- cancelled negatives with is_pre_guard_legacy (shared with 0293), and the
-- CHECK exempts marked rows, so all new writes (which default to unmarked)
-- stay fully guarded while the phantom variance stands. 0326 records the
-- same rows in upgrade_legacy_provenance; the preflight names that notice,
-- refuses only the remediable shape — negatives on a count still open for
-- correction, re-recorded through the engine — and corrects the position
-- with a NEW count. Nothing is auto-zeroed.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Exemption marker for pre-guard immutable history (U14, shared with 0293).
-- New writes default to unmarked and stay fully guarded; 0326 keys its
-- provenance rows off posted status plus this marker.
ALTER TABLE public.stock_count_lines
  ADD COLUMN IF NOT EXISTS is_pre_guard_legacy boolean NOT NULL DEFAULT false;

DO $classify$
DECLARE
  open_violations integer;
  offending text;
  grandfathered integer;
BEGIN
  -- Remediable shape first: negatives on counts still open for correction
  -- refuse by name. Re-record the true physical count (zero or more) through
  -- the engine — send the count back to counting first if it is awaiting
  -- review. Nothing is auto-zeroed.
  SELECT count(*) INTO open_violations
    FROM public.stock_count_lines l
    JOIN public.stock_counts c
      ON c.org_id = l.org_id AND c.id = l.stock_count_id
   WHERE counted_quantity IS NOT NULL AND counted_quantity < 0
     AND c.status NOT IN ('posted', 'cancelled');
  IF open_violations > 0 THEN
    SELECT string_agg(entry, E'\n') INTO offending FROM (
      SELECT format('count %s line %s (item %s at stock location %s) counted %s — re-record the true physical count (zero or more), sending the count back to counting first if it is awaiting review',
               l.stock_count_id, l.id, item_id, stock_location_id, counted_quantity) AS entry
        FROM public.stock_count_lines l
        JOIN public.stock_counts c
          ON c.org_id = l.org_id AND c.id = l.stock_count_id
       WHERE counted_quantity IS NOT NULL AND counted_quantity < 0
         AND c.status NOT IN ('posted', 'cancelled')
       ORDER BY l.stock_count_id, l.id
       LIMIT 5
    ) listed;
    RAISE EXCEPTION E'stock_count_lines holds % open line(s) with a negative counted_quantity; each lives on a count that can still be corrected. First lines:\n%', open_violations, offending;
  END IF;

  -- Immutable history: posted and cancelled negatives are preserved as
  -- evidence and marked. The phantom variance stands; the position is
  -- corrected with a NEW count.
  UPDATE public.stock_count_lines l
     SET is_pre_guard_legacy = true
    FROM public.stock_counts c
   WHERE c.org_id = l.org_id AND c.id = l.stock_count_id
     AND c.status IN ('posted', 'cancelled')
     AND counted_quantity IS NOT NULL AND counted_quantity < 0
     AND NOT l.is_pre_guard_legacy;
  GET DIAGNOSTICS grandfathered = ROW_COUNT;
  IF grandfathered > 0 THEN
    RAISE NOTICE '0299: % stock_count_lines row(s) hold a negative counted_quantity on a posted or cancelled count and predate the guard; negative count posted before the 0299 guard; phantom variance stands — grandfathered legacy (provenance recorded by 0326).', grandfathered;
  END IF;
END;
$classify$;

-- Converge installs recorded at the old digest (reapply path): they hold the
-- old CHECK without the legacy exemption. Drop it first — a metadata-only
-- lock, no scan — so the ADD below recreates the guard in its staged,
-- exempting form. Fresh installs and replays find nothing to drop.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stock_count_lines'::regclass
       AND conname = 'stock_count_lines_counted_nonnegative'
       AND pg_get_constraintdef(oid) NOT LIKE '%is_pre_guard_legacy%'
  ) THEN
    ALTER TABLE public.stock_count_lines DROP CONSTRAINT stock_count_lines_counted_nonnegative;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stock_count_lines'::regclass
       AND conname = 'stock_count_lines_counted_nonnegative'
  ) THEN
    ALTER TABLE public.stock_count_lines
      ADD CONSTRAINT stock_count_lines_counted_nonnegative
      CHECK (counted_quantity IS NULL OR counted_quantity >= 0 OR is_pre_guard_legacy)
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.stock_count_lines'::regclass
       AND conname = 'stock_count_lines_counted_nonnegative'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.stock_count_lines
      VALIDATE CONSTRAINT stock_count_lines_counted_nonnegative;
  END IF;
END
$$;

COMMENT ON CONSTRAINT stock_count_lines_counted_nonnegative ON public.stock_count_lines IS
  'A physical count is never negative: an empty bin counts 0. Negatives accepted before 0299 posted phantom negative variances; rows marked is_pre_guard_legacy predate the guard on an immutable count and are preserved as evidence (0299, provenance in 0326).';
