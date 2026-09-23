-- Rehearsal mechanization of the 0293.duplicate_subject remedy
-- (schema/migrations/preflight/0293_stock_count_line_subject_unique.sql).
--
-- Deterministic rule (also named in the preflight remedy text): on counts
-- that are NOT posted (posted counts are immutable — U13), keep the
-- lowest-id line per duplicate subject — a recount re-snapshots the one
-- line, it does not add a second — and delete the rest. Merging by hand,
-- keep one line per subject. Idempotent: a second run matches no group.
--
-- Self-contained for the rehearsal runner: one transaction as the migration
-- owner with the RLS bypass the forced-RLS catalog otherwise denies (the
-- owner would see zero rows and the file would silently do nothing).
begin;
set local app.bypass_rls = 'on';
DELETE FROM public.stock_count_lines dead
USING (SELECT (array_agg(l.id ORDER BY l.id))[1] AS keep_id, l.org_id, l.stock_count_id,
              l.item_id, l.stock_location_id, l.lot_id
         FROM public.stock_count_lines l
         JOIN public.stock_counts c
           ON c.id = l.stock_count_id AND c.org_id = l.org_id
        WHERE c.status IS DISTINCT FROM 'posted'
        GROUP BY l.org_id, l.stock_count_id, l.item_id, l.stock_location_id, l.lot_id
       HAVING count(*) > 1) dup,
      public.stock_counts kc
WHERE dead.org_id = dup.org_id
  AND dead.stock_count_id = dup.stock_count_id
  AND dead.item_id = dup.item_id
  AND dead.stock_location_id = dup.stock_location_id
  AND dead.lot_id IS NOT DISTINCT FROM dup.lot_id
  AND dead.id <> dup.keep_id
  AND kc.id = dead.stock_count_id
  AND kc.org_id = dead.org_id
  AND kc.status IS DISTINCT FROM 'posted';
commit;
