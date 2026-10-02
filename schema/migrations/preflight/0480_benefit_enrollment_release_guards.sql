SELECT '0480.native_decision_missing' AS code,'refuse' AS severity,e.id::text AS subject,
 'An active Flow-approved benefit election has no approved native gate evidence.' AS detail,
 'Review its native approval decision before updating enrollment lifecycle controls.' AS remedy
FROM public.hrm_benefit_enrollments e WHERE e.status='active' AND e.decision_snapshot->>'mode'='human'
 AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=e.org_id AND g.subject_kind='hrm_benefit_enrollment' AND g.subject_id=e.id AND g.status='approved' AND g.decided_by IS NOT NULL AND g.decided_at IS NOT NULL);
