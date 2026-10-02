SELECT '0478.recovery_bank_overlap' AS code,'refuse' AS severity,a.id::text AS subject,
 'Two benefit contribution rules own the same recovery bank during overlapping dates.' AS detail,
 'Close the prior rule before the successor begins; preserve the bank and its debt history.' AS remedy
FROM public.hrm_benefit_contribution_rules a JOIN public.hrm_benefit_contribution_rules b
 ON b.org_id=a.org_id AND b.arrears_plan_id=a.arrears_plan_id AND b.id>a.id
 AND daterange(a.effective_from,COALESCE(a.effective_to,DATE '9999-12-31'),'[]') && daterange(b.effective_from,COALESCE(b.effective_to,DATE '9999-12-31'),'[]');
