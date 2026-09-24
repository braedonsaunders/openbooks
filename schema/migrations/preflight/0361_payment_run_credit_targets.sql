SELECT
  'payment_run_credit_targets_missing'::text AS code,
  'refuse'::text AS severity,
  run.run_number::text AS subject,
  'This active run contains credit items whose target open lines were not captured by migration 0361.'::text AS detail,
  'Finish or cancel this run before retrying the upgrade; then create a newly planned run with the preserved credit targets.'::text AS remedy
FROM public.payment_run_items item
JOIN public.payment_runs run
  ON run.id = item.payment_run_id AND run.org_id = item.org_id
WHERE item.kind = 'credit'
  AND run.status IN ('draft', 'pending_approval', 'approved', 'processing', 'generated', 'delivered', 'partially_failed');
