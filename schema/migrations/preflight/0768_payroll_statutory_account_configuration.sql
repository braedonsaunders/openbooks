WITH mappings(key,system_keys) AS (VALUES
  ('cppPayableAccountId',ARRAY['cpp','cpp2']::text[]),
  ('eiPayableAccountId',ARRAY['ei','qpip']::text[]),
  ('taxPayableAccountId',ARRAY['income_tax']::text[]),
  ('vacationPayableAccountId',ARRAY['vacation_accrual']::text[])
)
SELECT DISTINCT '0768.unresolved_statutory_component_account' AS code, 'refuse' AS severity,
  'orgs/'||o.id||'/payroll/'||m.key AS subject,
  'An unmapped native statutory component has a retained account that is not an active posting liability in its organization.' AS detail,
  'Map the statutory slot through Payroll setup → Accounts & posting, preserve its original configuration evidence, and retry the native upgrade.' AS remedy
FROM public.orgs o
JOIN mappings m ON o.settings->'payroll' ? m.key
JOIN public.pay_components p ON p.org_id=o.id AND p.country='CA' AND p.is_active
  AND p.system_key=ANY(m.system_keys) AND p.liability_account_id IS NULL
WHERE o.settings#>>ARRAY['payroll',m.key] IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.accounts a
    WHERE a.org_id=o.id AND a.id::text=lower(o.settings#>>ARRAY['payroll',m.key])
      AND a.is_active AND NOT a.is_summary AND a.type IN ('liability_payable','liability_current_other'));
