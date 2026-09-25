-- OpenBooks upgrade preflight for 0372_hrm_benefit_election_date_exclusion.
-- Active elections may not cover the same date for one employment and plan.
WITH active_elections AS (
  SELECT org_id, employment_id, plan_id, id, status, effective_from, effective_to
  FROM public.hrm_benefit_enrollments
  WHERE status IN ('elected', 'pending_approval', 'active')
)
SELECT
  'hrm_benefit_election_date_overlap'::text AS code,
  'refuse'::text AS severity,
  format('enrollments %s and %s', e1.id, e2.id)::text AS subject,
  format(
    'Active benefit enrollments %s (%s..%s) and %s (%s..%s) overlap for employment %s and plan %s.',
    e1.id,
    e1.effective_from,
    coalesce(e1.effective_to::text, 'open'),
    e2.id,
    e2.effective_from,
    coalesce(e2.effective_to::text, 'open'),
    e1.employment_id,
    e1.plan_id
  )::text AS detail,
  'Use the audited benefit lifecycle to end or correct one overlapping enrollment for this employment and plan, then rerun the migration.'::text AS remedy
FROM active_elections AS e1
JOIN active_elections AS e2
  ON e2.org_id = e1.org_id
 AND e2.employment_id = e1.employment_id
 AND e2.plan_id = e1.plan_id
 AND e2.id > e1.id
 AND daterange(e1.effective_from, coalesce(e1.effective_to, DATE '9999-12-31'), '[]')
     && daterange(e2.effective_from, coalesce(e2.effective_to, DATE '9999-12-31'), '[]');
