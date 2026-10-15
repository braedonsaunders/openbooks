WITH findings AS (
 SELECT '0724.lineage_relation_exists'::text AS code,
  'public.payroll_us_filing_account_employer_lineage already exists without this migration being recorded'::text AS subject,
  'This migration introduces a source-qualified dated employer lineage relation without backfilling historical ownership.'::text AS detail,
  'Preserve the relation and tenant data; compare every column, constraint, index, policy, trigger and catalog entry with the reviewed migration and obtain the database owner’s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.payroll_us_filing_account_employer_lineage') IS NOT NULL
 UNION ALL
 SELECT '0724.lineage_function_exists','a filing-account lineage function exists without this migration being recorded',
  'The migration creates strict clone, retained-history and original-account identity guards.',
  'Preserve the functions and compare their complete definitions with the reviewed migration before proceeding.'
 WHERE to_regprocedure('public.payroll_us_filing_account_lineage_clone_matches(jsonb)') IS NOT NULL
  OR to_regprocedure('public.payroll_us_filing_account_lineage_guard()') IS NOT NULL
  OR to_regprocedure('public.payroll_us_filing_account_lineage_account_guard()') IS NOT NULL
 UNION ALL
 SELECT '0724.lineage_source_missing','a native filing-account or payroll source relation is missing',
  'Original account ownership and committed source-date protection require the native filing accounts, employers, runs and stubs.',
  'Preserve tenant data and install the published native payroll source migrations through the authorized migration runner.'
 WHERE to_regclass('public.payroll_filing_accounts') IS NULL OR to_regclass('public.subsidiaries') IS NULL
  OR to_regclass('public.pay_runs') IS NULL OR to_regclass('public.pay_stubs') IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
