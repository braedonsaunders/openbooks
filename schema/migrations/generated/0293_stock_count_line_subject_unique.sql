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
-- No existing row is expected to conflict (every writer paths through
-- createStockCount, which preflights); the pre-check below refuses by
-- name, listing the offending counts, rather than letting ADD CONSTRAINT
-- fail with a bare unique violation. Nothing is auto-deleted.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

DO $precheck$
DECLARE
  dup_count integer;
  offending text;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT org_id, stock_count_id, item_id, stock_location_id, lot_id
      FROM public.stock_count_lines
     GROUP BY org_id, stock_count_id, item_id, stock_location_id, lot_id
    HAVING count(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    SELECT string_agg(entry, E'\n') INTO offending FROM (
      SELECT format('count %s holds %s lines for item %s at stock location %s lot %s',
               stock_count_id, n, item_id, stock_location_id, coalesce(lot_id::text, '(none)')) AS entry
        FROM (
          SELECT org_id, stock_count_id, item_id, stock_location_id, lot_id, count(*) AS n
            FROM public.stock_count_lines
           GROUP BY org_id, stock_count_id, item_id, stock_location_id, lot_id
          HAVING count(*) > 1
           ORDER BY stock_count_id, item_id, stock_location_id
           LIMIT 5
        ) first_dups
    ) listed;
    RAISE EXCEPTION E'stock_count_lines holds % duplicate (item, stock location, lot) subject group(s); merge each group into one line per count before applying 0293. First groups:\n%', dup_count, offending;
  END IF;
END;
$precheck$;

ALTER TABLE public.stock_count_lines
  ADD CONSTRAINT stock_count_lines_no_duplicate_subject
  UNIQUE NULLS NOT DISTINCT (org_id, stock_count_id, item_id, stock_location_id, lot_id);

COMMENT ON CONSTRAINT stock_count_lines_no_duplicate_subject ON public.stock_count_lines IS
  'One line per (count, item, stock location, lot) subject. Duplicate subjects double-applied the variance before 0293; recounts re-snapshot the one line (0293).';
