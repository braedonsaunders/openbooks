SELECT '0482.native_identity_collision' AS code,'refuse' AS severity,id::text AS subject,
 'Native benefit offerings share an identity and cannot become distinct programs.' AS detail,
 'Resolve the conflicting native record identities before applying the program migration.' AS remedy
FROM (SELECT id FROM public.hrm_benefit_plans UNION ALL SELECT id FROM public.hrm_benefit_programs UNION ALL SELECT id FROM public.entitlement_plans) offerings
GROUP BY id HAVING count(*)>1
UNION ALL
SELECT '0482.vacation_program_missing' AS code,'refuse' AS severity,t.org_id::text AS subject,
 'Employee vacation terms have no authoritative native vacation plan.' AS detail,
 'Create the organization''s entitlement plan with the vacation engine binding before applying this migration.' AS remedy
FROM public.payroll_vacation_terms t WHERE NOT EXISTS(SELECT 1 FROM public.entitlement_plans p WHERE p.org_id=t.org_id AND p.system_key='vacation') GROUP BY t.org_id;
