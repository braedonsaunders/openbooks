SELECT
  '0357.hrm_succession_candidate_order_tie'::text AS code,
  'refuse'::text AS severity,
  format('plan %s, rank %s', ties.plan_id, ties.candidate_order) AS subject,
  format(
    'Plan %s has %s candidates tied at rank %s; candidate order must be unique within the plan.',
    ties.plan_id,
    ties.candidate_count,
    ties.candidate_order
  ) AS detail,
  'Run schema/migrations/preflight/remedies/hrm_succession_candidate_order_tie.sql to preserve current order deterministically, then rerun the migration.'::text AS remedy
FROM (
  SELECT plan_id, candidate_order, count(*) AS candidate_count
  FROM public.hrm_succession_candidates
  GROUP BY plan_id, candidate_order
  HAVING count(*) > 1
) AS ties;
