SELECT '0476.employee_component_missing' AS code, 'refuse' AS severity, p.id::text AS subject, 'A priced benefit plan has no employee payroll component.' AS detail, 'Link the employee deduction component before migrating.' AS remedy
FROM public.hrm_benefit_plans p WHERE p.employee_pay_component_id IS NULL AND (coalesce(p.employee_cost,0) > 0 OR EXISTS
 (SELECT 1 FROM public.hrm_benefit_plan_levels l WHERE l.org_id=p.org_id AND l.plan_id=p.id AND l.employee_cost>0))
UNION ALL
SELECT '0476.employer_component_missing', 'refuse', p.id::text, 'A priced benefit plan has no employer payroll component.', 'Link the employer contribution component before migrating.'
FROM public.hrm_benefit_plans p WHERE p.employer_pay_component_id IS NULL AND (coalesce(p.employer_cost,0) > 0 OR EXISTS
 (SELECT 1 FROM public.hrm_benefit_plan_levels l WHERE l.org_id=p.org_id AND l.plan_id=p.id AND l.employer_cost>0))
UNION ALL
SELECT '0476.annualization_schedule_missing', 'refuse', e.id::text, 'An active monthly or annual benefit election has no declared pay schedule.', 'Configure the employment payroll profile and pay schedule before migrating.'
FROM public.hrm_benefit_enrollments e JOIN public.hrm_benefit_plans p ON p.org_id=e.org_id AND p.id=e.plan_id
WHERE e.status='active' AND (p.employee_cost_basis IN ('per_month','per_year') OR p.employer_cost_basis IN ('per_month','per_year'))
AND NOT EXISTS (SELECT 1 FROM public.employee_payroll_profiles pp JOIN public.pay_schedules ps ON ps.org_id=pp.org_id AND ps.id=pp.pay_schedule_id WHERE pp.org_id=e.org_id AND pp.employment_id=e.employment_id);
