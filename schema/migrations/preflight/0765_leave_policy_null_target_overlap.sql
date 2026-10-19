SELECT '0765.leave_policy_untargeted_overlap'::text AS code,
       'refuse'::text AS severity,
       concat(a.org_id, ':', a.id, ':', b.id) AS subject,
       'Two active untargeted leave policies cover the same leave type, scope and effective days.'::text AS detail,
       'Use Setup → Leave policies to end or deactivate an overlapping policy without deleting historical records, then retry the upgrade.'::text AS remedy
  FROM public.hrm_leave_policies a
  JOIN public.hrm_leave_policies b
    ON a.org_id = b.org_id
   AND a.leave_type_id = b.leave_type_id
   AND a.id < b.id
   AND coalesce(a.applies_employer_subsidiary_id::text, '') = coalesce(b.applies_employer_subsidiary_id::text, '')
   AND coalesce(a.applies_department_id::text, '') = coalesce(b.applies_department_id::text, '')
   AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]')
 WHERE a.is_active AND b.is_active
   AND coalesce(a.applies_to -> 'employment_ids', 'null'::jsonb) IN ('null'::jsonb, '[]'::jsonb)
   AND coalesce(a.applies_to -> 'classification_ids', 'null'::jsonb) IN ('null'::jsonb, '[]'::jsonb)
   AND coalesce(b.applies_to -> 'employment_ids', 'null'::jsonb) IN ('null'::jsonb, '[]'::jsonb)
   AND coalesce(b.applies_to -> 'classification_ids', 'null'::jsonb) IN ('null'::jsonb, '[]'::jsonb);
