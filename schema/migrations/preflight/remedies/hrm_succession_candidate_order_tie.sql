BEGIN;
SET LOCAL app.bypass_rls = 'on';

WITH tied_plans AS (
  SELECT plan_id
  FROM public.hrm_succession_candidates
  GROUP BY plan_id, candidate_order
  HAVING count(*) > 1
), ranked AS (
  SELECT candidate.id,
         row_number() OVER (
           PARTITION BY candidate.plan_id
           ORDER BY candidate.candidate_order, candidate.created_at, candidate.id
         ) - 1 AS new_order
  FROM public.hrm_succession_candidates AS candidate
  JOIN tied_plans USING (plan_id)
)
UPDATE public.hrm_succession_candidates AS candidate
   SET candidate_order = ranked.new_order::integer,
       updated_at = now()
  FROM ranked
 WHERE candidate.id = ranked.id;

COMMIT;
