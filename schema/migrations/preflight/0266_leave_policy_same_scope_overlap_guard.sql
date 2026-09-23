-- OpenBooks upgrade preflight for 0266_leave_policy_same_scope_overlap_guard.
--
-- Read-only mirror of the migration's overlap precheck, using the exact
-- scope pins (0194 STORED GENERATED columns, text-coalesced so two org-wide
-- NULL-pin policies still collide) and the exclusion key. Overlapping
-- same-scope windows resolved by row order, not policy. Zero rows = ready.
SELECT '0266.overlapping_leave_window' AS code,
       'refuse' AS severity,
       format('org %s leave type %s: policies %s [%s, %s] and %s [%s, %s] share active days in one scope',
              a.org_id, a.leave_type_id,
              a.id, a.effective_from, coalesce(a.effective_to::text, 'open'),
              b.id, b.effective_from, coalesce(b.effective_to::text, 'open')) AS subject,
       format('hrm_leave_policies rows %s and %s are both active with intersecting windows under identical scope pins (subsidiary %s, department %s)',
              a.id, b.id,
              coalesce(a.applies_employer_subsidiary_id::text, '(org-wide)'),
              coalesce(a.applies_department_id::text, '(org-wide)')) AS detail,
       'Close one window of each pair (set effective_to) or deactivate the duplicate policy before applying 0266.' AS remedy
  FROM public.hrm_leave_policies a
  JOIN public.hrm_leave_policies b
    ON a.org_id = b.org_id
   AND a.leave_type_id = b.leave_type_id
   AND coalesce(a.applies_employer_subsidiary_id::text, '') = coalesce(b.applies_employer_subsidiary_id::text, '')
   AND coalesce(a.applies_department_id::text, '') = coalesce(b.applies_department_id::text, '')
   AND a.id < b.id
   AND a.is_active AND b.is_active
   AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]')
 ORDER BY a.org_id, a.leave_type_id
 LIMIT 20;
