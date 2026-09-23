-- Rehearsal mechanization of the 0299.negative_counted_quantity remedy
-- (schema/migrations/preflight/0299_stock_count_line_counted_nonnegative.sql).
--
-- Deterministic rule (also named in the preflight remedy text): an operator
-- holding the live observation re-records the true physical count, which no
-- SQL can invent. This file takes the lost-observation branch: delete the
-- DRAFT counts holding negative lines — identified by the same predicate
-- the preflight uses, never by ids — and recount afterwards. Posted counts
-- are immutable (U14) and are never touched; their grandfathered notice
-- stands. Lines go first (the count FK is NO ACTION), then the counts.
-- Idempotent: a second run matches no count.
--
-- Self-contained for the rehearsal runner: one transaction as the migration
-- owner with the RLS bypass the forced-RLS catalog otherwise denies.
begin;
set local app.bypass_rls = 'on';
DELETE FROM public.stock_count_lines l
USING public.stock_counts c
WHERE c.id = l.stock_count_id
  AND c.org_id = l.org_id
  AND c.status IS DISTINCT FROM 'posted'
  AND EXISTS (SELECT 1 FROM public.stock_count_lines neg
               WHERE neg.org_id = c.org_id
                 AND neg.stock_count_id = c.id
                 AND neg.counted_quantity IS NOT NULL
                 AND neg.counted_quantity < 0);
DELETE FROM public.stock_counts c
WHERE c.status IS DISTINCT FROM 'posted'
  AND EXISTS (SELECT 1 FROM public.stock_count_lines neg
               WHERE neg.org_id = c.org_id
                 AND neg.stock_count_id = c.id
                 AND neg.counted_quantity IS NOT NULL
                 AND neg.counted_quantity < 0);
commit;
