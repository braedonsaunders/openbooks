WITH period_collisions AS (
  SELECT
    left_run.org_id,
    left_run.pay_schedule_id,
    left_run.period_start AS left_start,
    left_run.period_end AS left_end,
    right_run.period_start AS right_start,
    right_run.period_end AS right_end
  FROM public.pay_runs AS left_run
  JOIN public.pay_runs AS right_run
    ON right_run.org_id = left_run.org_id
   AND right_run.pay_schedule_id = left_run.pay_schedule_id
   AND right_run.document_id > left_run.document_id
   AND daterange(right_run.period_start, right_run.period_end, '[]')
       && daterange(left_run.period_start, left_run.period_end, '[]')
  WHERE left_run.run_type = 'regular'
    AND right_run.run_type = 'regular'
    AND left_run.run_status <> 'voided'
    AND right_run.run_status <> 'voided'
)
SELECT
  'pay_runs_regular_schedule_overlap'::text AS code,
  'refuse'::text AS severity,
  concat(org_id::text, '/', pay_schedule_id::text) AS subject,
  'Live regular payroll periods overlap for one organization and schedule.'::text AS detail,
  'Use the controlled payroll void workflow to correct the overlapping run(s) while preserving posted history, then rerun this preflight.'::text AS remedy
FROM period_collisions;
