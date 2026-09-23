-- OpenBooks forward migration 0293_stock_count_line_subject_unique.
--
-- A cycle count snapshots one expected quantity per (item, stock location,
-- lot) subject and posts one variance per line. Nothing refused a count
-- carrying the same subject twice, so two duplicate lines each posted the
-- full variance: on hand 10 counted 9 on both lines ended at 8, with two
-- movements and two GL postings for one physical observation. Duplicate
-- subjects are never meaningful — a recount re-snapshots the one line, it
-- does not add a second — while the same item at two warehouses, or two
-- lots of a lot-tracked item, stay legal and keep their own lines.
--
-- Storage now refuses a second line per (org, count, item, stock location,
-- lot). NULLS NOT DISTINCT matters: an untracked item's lines carry NULL
-- lot_id, and without it the most common duplicate — the same item counted
-- twice with no lot — would escape the guard entirely. The engine preflights
-- the same key at creation with a remedy-naming refusal; only storage can
-- arbitrate the READ COMMITTED race between two concurrent writers, which
-- is why the guard lives here as well as there.
--
-- Staged build (U10): the guard is a UNIQUE NULLS NOT DISTINCT index over a
-- populated table, so building it inside the tracked transaction would hold
-- the ALTER TABLE lock for the whole index build. The file declares
-- `-- openbooks: no-transaction` and the runner executes it statement by
-- statement: the index builds with CREATE UNIQUE INDEX CONCURRENTLY (valid
-- for NULLS NOT DISTINCT in PG15+; the repo targets PG16), which takes no
-- blocking lock. ADD CONSTRAINT ... UNIQUE USING INDEX cannot attach a
-- partial index — PostgreSQL refuses expression and partial indexes there —
-- so enforcement lives on the standalone unique index itself under the same
-- name: a duplicate insert still fails with a unique violation naming
-- stock_count_lines_no_duplicate_subject, and the engine creation preflight
-- still names the offender first. The contract that makes a mid-file failure
-- retry-safe: every statement is idempotent (IF NOT EXISTS throughout, the
-- classify block re-runnable), and the DO block up front drops this file's
-- own INVALID index — a failed CONCURRENTLY build leaves one behind, and
-- IF NOT EXISTS would otherwise skip the name forever, silently keeping the
-- missing guard. Plain (non-concurrent) DROP inside the DO block is safe:
-- an INVALID index answers no query, so its brief exclusive lock contends
-- with nothing.
--
-- Legacy preservation (U13): the historical bug already posted. Lines on a
-- posted or cancelled count are immutable — the engine refuses their edit
-- and their count's cancellation alike, and lines carry no delete path — so
-- "merge each group into one line" is not an executable remedy for them.
-- Those rows are preserved as evidence: the classify block marks every line
-- of a duplicate group on a posted or cancelled count with
-- is_pre_guard_legacy, and the unique index covers only unmarked rows, so
-- all new writes (which default to unmarked) stay fully guarded while the
-- double-posted variance stands. 0326 records the same rows in
-- upgrade_legacy_provenance (posted status plus this marker); the preflight
-- names that notice and refuses only the remediable shape — duplicates on a
-- count still open for correction, where the executable remedy is to cancel
-- the count (the cancelled husk keeps its lines as evidence) and open a new
-- count with one line per subject. Nothing is auto-deleted or auto-merged.
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

-- Exemption marker for pre-guard immutable history (U13). New writes default
-- to unmarked and stay fully guarded; 0326 keys its provenance rows off
-- posted status plus this marker.
ALTER TABLE public.stock_count_lines
  ADD COLUMN IF NOT EXISTS is_pre_guard_legacy boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.stock_count_lines.is_pre_guard_legacy IS
  'True for lines that predate the 0293/0299 guards on an immutable (posted or cancelled) count and are preserved as evidence: exempt from the duplicate-subject unique index and the non-negative CHECK. Never set on new writes.';

DO $classify$
DECLARE
  open_groups integer;
  offending text;
  grandfathered integer;
BEGIN
  -- Remediable shape first: a duplicate group on a count still open for
  -- correction refuses by name. Subjects are immutable once written and
  -- lines carry no delete path, so the remedy is cancel-and-recount: cancel
  -- the count (legal while nothing posted; the husk keeps its lines) and
  -- open a new count with one line per subject.
  SELECT count(*) INTO open_groups FROM (
    SELECT l.org_id, l.stock_count_id, l.item_id, l.stock_location_id, l.lot_id
      FROM public.stock_count_lines l
      JOIN public.stock_counts c
        ON c.org_id = l.org_id AND c.id = l.stock_count_id
     WHERE c.status NOT IN ('posted', 'cancelled')
     GROUP BY l.org_id, l.stock_count_id, l.item_id, l.stock_location_id, l.lot_id
    HAVING count(*) > 1
  ) dups;
  IF open_groups > 0 THEN
    SELECT string_agg(entry, E'\n') INTO offending FROM (
      SELECT format('count %s holds %s lines for item %s at stock location %s lot %s — cancel the count and open a new count with one line per subject',
               stock_count_id, n, item_id, stock_location_id, coalesce(lot_id::text, '(none)')) AS entry
        FROM (
          SELECT l.org_id, l.stock_count_id, l.item_id, l.stock_location_id, l.lot_id, count(*) AS n
            FROM public.stock_count_lines l
            JOIN public.stock_counts c
              ON c.org_id = l.org_id AND c.id = l.stock_count_id
           WHERE c.status NOT IN ('posted', 'cancelled')
           GROUP BY l.org_id, l.stock_count_id, l.item_id, l.stock_location_id, l.lot_id
          HAVING count(*) > 1
           ORDER BY l.stock_count_id, l.item_id, l.stock_location_id
           LIMIT 5
        ) first_dups
    ) listed;
    RAISE EXCEPTION E'stock_count_lines holds % open duplicate (item, stock location, lot) subject group(s); each group lives on a count that can still be corrected. First groups:\n%', open_groups, offending;
  END IF;

  -- Immutable history: every line of a duplicate group on a posted or
  -- cancelled count is preserved as evidence and marked. The sibling check
  -- uses IS NOT DISTINCT FROM, never IN: IN never matches NULL lot_id,
  -- which is exactly the most common duplicate.
  WITH dup_members AS (
    SELECT l.id
      FROM public.stock_count_lines l
      JOIN public.stock_counts c
        ON c.org_id = l.org_id AND c.id = l.stock_count_id
     WHERE c.status IN ('posted', 'cancelled')
       AND EXISTS (
         SELECT 1
           FROM public.stock_count_lines s
          WHERE s.org_id = l.org_id
            AND s.stock_count_id = l.stock_count_id
            AND s.item_id = l.item_id
            AND s.stock_location_id = l.stock_location_id
            AND s.lot_id IS NOT DISTINCT FROM l.lot_id
            AND s.id <> l.id
       )
  )
  UPDATE public.stock_count_lines l
     SET is_pre_guard_legacy = true
    FROM dup_members d
   WHERE l.id = d.id AND NOT l.is_pre_guard_legacy;
  GET DIAGNOSTICS grandfathered = ROW_COUNT;
  IF grandfathered > 0 THEN
    RAISE NOTICE '0293: % stock_count_lines row(s) carry a duplicate subject on a posted or cancelled count and predate the guard; double-posted variance stands — grandfathered legacy (provenance recorded by 0326).', grandfathered;
  END IF;
END;
$classify$;

-- Retry safety: drop our own INVALID index before rebuilding. A failed
-- CONCURRENTLY build leaves the name present but unusable, and IF NOT
-- EXISTS below would then skip it forever.
DO $$
DECLARE
  idx text;
BEGIN
  FOR idx IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid
       AND c.relname IN ('stock_count_lines_no_duplicate_subject')
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx);
  END LOOP;
END
$$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS stock_count_lines_no_duplicate_subject
  ON public.stock_count_lines USING btree (org_id, stock_count_id, item_id, stock_location_id, lot_id)
  NULLS NOT DISTINCT
  WHERE (NOT is_pre_guard_legacy);

COMMENT ON INDEX public.stock_count_lines_no_duplicate_subject IS
  'One line per (count, item, stock location, lot) subject for all unmarked rows. Duplicate subjects double-applied the variance before 0293; recounts re-snapshot the one line. Rows marked is_pre_guard_legacy predate the guard on an immutable count and are preserved as evidence (0293, provenance in 0326).';
