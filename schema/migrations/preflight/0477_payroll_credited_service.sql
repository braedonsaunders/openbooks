SELECT '0477.service_threshold_invalid' AS code, 'refuse' AS severity,
 jsonb_build_object('organization',org_id,'plan',plan_id,'component',component_id,'months',after_months)::text AS subject,
 'A service schedule has an invalid or duplicate threshold.' AS detail,
 'Correct the duplicate or negative service threshold in Payroll service tiers before migrating.' AS remedy
 FROM public.entitlement_service_tiers
 GROUP BY org_id, plan_id, component_id, after_months
 HAVING count(*) > 1 OR min(after_months) < 0
 UNION ALL
 SELECT '0477.vacation_employment_missing', 'notice', id::text,
 'A payroll profile has no explicit employment link. Its vacation fields remain immutable historical evidence; they are not used as live vacation policy.',
 'Configure effective-dated Vacation terms for the selected employment in Payroll before calculating payroll. Missing terms refuse calculation.'
 FROM public.employee_payroll_profiles
 WHERE employment_id IS NULL AND (vacation_percent IS NOT NULL OR vacation_method <> 'accrue');
