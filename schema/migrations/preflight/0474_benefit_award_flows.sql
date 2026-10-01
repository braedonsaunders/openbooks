SELECT '0474.benefit_award_state' AS code, 'refuse' AS severity,
  'Benefits reward ' || id::text || ' in organization ' || org_id::text AS subject,
  CASE WHEN status NOT IN ('draft','pending','approved','queued','delivered','voided')
    THEN 'The reward carries an unsupported lifecycle state: ' || status
    ELSE 'A pending reward carries approval or payroll evidence and cannot be returned to draft without reinterpreting a financial obligation.'
  END AS detail,
  CASE WHEN status = 'pending' AND pay_run_document_id IS NULL AND pay_run_adjustment_id IS NULL AND external_ref IS NULL
    THEN 'Void this pending reward through its record action before upgrading; preserve its events and issue a new reward afterward.'
    ELSE 'Reconcile the recorded reward state through an audited native maintenance amendment (withBypassContext and openbooks.amend), preserving linked payroll rows and original approval evidence, before upgrading.'
  END AS remedy
FROM public.hrm_benefit_awards
WHERE status NOT IN ('draft','pending','approved','queued','delivered','voided')
  OR (status = 'pending' AND (approved_by IS NOT NULL OR approved_at IS NOT NULL
    OR pay_run_document_id IS NOT NULL OR pay_run_adjustment_id IS NOT NULL OR external_ref IS NOT NULL)) LIMIT 1;
