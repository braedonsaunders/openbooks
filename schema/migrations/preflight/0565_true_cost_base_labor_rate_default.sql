WITH ambiguous AS (
  SELECT o.id AS org_id, p.elem ->> 'id' AS profile_id,
    coalesce(p.elem ->> 'name', p.elem ->> 'id') AS profile_name
  FROM public.orgs o,
    LATERAL jsonb_array_elements(
      o.settings -> 'analytics' -> 'trueCost' -> 'profiles'
    ) AS p(elem)
  WHERE jsonb_typeof(o.settings -> 'analytics' -> 'trueCost' -> 'profiles') = 'array'
    AND p.elem ->> 'baseLaborRate' = '50.0000'
    AND EXISTS (
      SELECT 1 FROM public.audit_log a
      WHERE a.org_id = o.id
        AND a.changes::text LIKE '%baseLaborRate%'
        AND a.changes::text LIKE '%50.0000%'
    )
)
SELECT '0565.ambiguous_base_labor_rate' AS code, 'notice' AS severity,
 o.id::text || '/' || a.profile_id AS subject,
 'True Cost profile "' || a.profile_name || '" still carries baseLaborRate 50.0000 and the audit log holds a true-cost config write carrying that value, so migration 0565 left it untouched rather than risk clearing an operator rate.' AS detail,
 'Open the True Cost profile and decide: if 50.0000 is the intended rate, re-enter it explicitly; if it is the retired default, clear the field so the loader refuses by name until a rate is set.' AS remedy
FROM ambiguous a
JOIN public.orgs o ON o.id = a.org_id;
