SELECT 'service tiers contain an invalid or duplicate threshold' AS issue
 FROM public.entitlement_service_tiers
 GROUP BY org_id, plan_id, component_id, after_months HAVING count(*) > 1 OR min(after_months) < 0
 UNION ALL SELECT 'payroll vacation configuration has no employment link' AS issue FROM public.employee_payroll_profiles WHERE employment_id IS NULL AND (vacation_percent IS NOT NULL OR vacation_method <> 'accrue') LIMIT 1;
