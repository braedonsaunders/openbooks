-- Refuse a partial breakage-assessment installation before changing the governed event bindings.
SELECT 'prepaid breakage assessment binding already exists without its migration' AS issue
WHERE to_regprocedure('public.prepaid_breakage_change_binding()') IS NOT NULL
  OR to_regclass('public.financial_changes_prepaid_breakage') IS NOT NULL;
