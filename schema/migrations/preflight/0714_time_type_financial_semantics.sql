WITH invalid AS (
  SELECT 'time_entries'::text AS table_name, r.org_id, r.id
  FROM public.time_entries r
  WHERE r.time_type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.time_types t WHERE t.org_id=r.org_id AND t.id=r.time_type_id
  )
  UNION ALL
  SELECT 'pay_stub_lines', r.org_id, r.id
  FROM public.pay_stub_lines r
  WHERE r.time_type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.time_types t WHERE t.org_id=r.org_id AND t.id=r.time_type_id
  )
)
SELECT '0714.time_type_policy_ownership'::text AS code, 'refuse'::text AS severity,
  format('org %s, %s row %s', org_id, table_name, id) AS subject,
  'A retained time-type reference does not resolve to a policy in the same organization.'::text AS detail,
  'Preserve the source and financial records; qualify the original policy ownership through governed correction before upgrading.'::text AS remedy
FROM invalid;
