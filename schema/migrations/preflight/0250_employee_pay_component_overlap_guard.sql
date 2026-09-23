-- OpenBooks upgrade preflight for 0250_employee_pay_component_overlap_guard.
--
-- Read-only mirror of the migration's overlap precheck, using the exact
-- business key the exclusion constraint arbitrates: (org,
-- coalesce(employment_id, employee_party_id), component). Two overlapping
-- active windows would pay the employee twice. Zero rows means ready.
SELECT '0250.overlapping_assignment' AS code,
       'refuse' AS severity,
       format('org %s assignment key %s component %s: rows %s [%s, %s] and %s [%s, %s] overlap',
              a.org_id, coalesce(a.employment_id, a.employee_party_id), a.component_id,
              a.id, a.effective_from, coalesce(a.effective_to::text, 'open'),
              b.id, b.effective_from, coalesce(b.effective_to::text, 'open')) AS subject,
       format('employee_pay_components rows %s and %s are both active over the same assignment and their effective windows intersect',
              a.id, b.id) AS detail,
       'Close or deactivate the duplicate windows (set effective_to or is_active false) before applying 0250.' AS remedy
  FROM public.employee_pay_components a
  JOIN public.employee_pay_components b
    ON a.org_id = b.org_id
   AND coalesce(a.employment_id, a.employee_party_id) = coalesce(b.employment_id, b.employee_party_id)
   AND a.component_id = b.component_id
   AND a.id < b.id
   AND a.is_active AND b.is_active
   AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]')
 ORDER BY a.org_id, a.component_id
 LIMIT 20;
