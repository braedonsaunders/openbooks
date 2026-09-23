-- Rehearsal mechanization of the 0299.negative_counted_quantity remedy
-- (schema/migrations/preflight/0299_stock_count_line_counted_nonnegative.sql).
--
-- Deterministic rule (also named in the preflight remedy text): an operator
-- holding the live observation re-records the true physical count, which no
-- SQL can invent. This file takes the lost-observation branch: delete the
-- counts still open for correction holding negative lines — identified by
-- the same predicate the preflight uses, never by ids — and recount
-- afterwards. Posted and cancelled counts are immutable (U14 restaged) and
-- are never touched; their grandfathered notice stands. Lines go first (the
-- count FK is NO ACTION), then the counts. Idempotent: a second run matches
-- no count.
--
-- Self-contained for the rehearsal runner: one transaction as the migration
-- owner with the RLS bypass the forced-RLS catalog otherwise denies.
begin;
set local app.bypass_rls = 'on';
-- One statement: the target counts are picked ONCE in `target` (all CTEs
-- share one snapshot), so the count delete cannot observe the line delete's
-- effects. Two sequential DELETEs left the counts behind EMPTY, because the
-- second EXISTS saw the first statement's deletions and matched nothing.
WITH target AS (
  SELECT c.id, c.org_id
    FROM public.stock_counts c
   WHERE c.status NOT IN ('posted', 'cancelled')
     AND EXISTS (SELECT 1 FROM public.stock_count_lines neg
                  WHERE neg.org_id = c.org_id
                    AND neg.stock_count_id = c.id
                    AND neg.counted_quantity IS NOT NULL
                    AND neg.counted_quantity < 0)
),
gone_lines AS (
  DELETE FROM public.stock_count_lines l
  USING target t
  WHERE l.org_id = t.org_id
    AND l.stock_count_id = t.id
  RETURNING 1
)
DELETE FROM public.stock_counts c
USING target t
WHERE c.org_id = t.org_id
  AND c.id = t.id;
commit;
