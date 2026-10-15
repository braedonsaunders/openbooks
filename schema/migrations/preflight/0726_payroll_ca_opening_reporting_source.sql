WITH findings AS (
 SELECT '0726.reporting_relation_exists'::text AS code,
  'An original Canadian opening reporting relation exists without this migration being recorded'::text AS subject,
  'The migration creates sealed, tenant-scoped original reporting authorities and RP/province slices without adopting historical records.'::text AS detail,
  'Preserve every object and tenant row; compare all columns, constraints, indexes, policies, functions, triggers and catalog entries with the reviewed migration and obtain the database owner’s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.payroll_ca_opening_reporting_authorities') IS NOT NULL
  OR to_regclass('public.payroll_ca_opening_reporting_allocations') IS NOT NULL
 UNION ALL
 SELECT '0726.reporting_function_exists','An original Canadian opening reporting function exists without this migration being recorded',
  'All reporting snapshot and immutable source guards must match the published migration bytes.',
  'Preserve the functions and tenant data; compare complete definitions with the reviewed migration and obtain the database owner’s approval before reconciliation.'
 WHERE to_regprocedure('public.payroll_ca_opening_reporting_annual(jsonb)') IS NOT NULL
  OR to_regprocedure('public.payroll_ca_opening_reporting_allocations_snapshot(uuid,uuid)') IS NOT NULL
  OR to_regprocedure('public.payroll_ca_opening_reporting_child_identity(text,jsonb)') IS NOT NULL
  OR to_regprocedure('public.payroll_ca_opening_reporting_authority_guard()') IS NOT NULL
  OR to_regprocedure('public.payroll_ca_opening_reporting_allocation_guard()') IS NOT NULL
  OR to_regprocedure('public.payroll_ca_opening_reporting_sealed_guard()') IS NOT NULL
  OR to_regprocedure('public.payroll_ca_opening_reporting_account_guard()') IS NOT NULL
 UNION ALL
 SELECT '0726.current_levy_source_missing','public.payroll_opening_levy_source_authorities.supersedes_authority_id',
  'Reporting certificates bind the exact current original levy authority and retain predecessor evidence without selecting it as current.',
  'Install the published original levy correction migration through the authorized native migration runner; preserve all source certificates and their tenant data.'
 WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
  WHERE attrelid=to_regclass('public.payroll_opening_levy_source_authorities') AND attname='supersedes_authority_id' AND NOT attisdropped)
 UNION ALL
 SELECT '0726.current_levy_source_missing','public.payroll_opening_source_children(uuid,uuid,uuid,integer)',
  'Reporting certificates require the native original levy source child snapshot.',
  'Install the published original levy source migration through the authorized native migration runner; preserve all source certificates and tenant data.'
 WHERE to_regprocedure('public.payroll_opening_source_children(uuid,uuid,uuid,integer)') IS NULL
 UNION ALL
 SELECT '0726.native_source_missing',required.relation,
  'Original reporting qualification requires native opening amounts, all four child families, retained Cabinet versions and source-consumption history.',
  'Install the published native payroll and Cabinet prerequisites through the authorized migration runner; preserve tenant history.'
 FROM (VALUES
  ('public.payroll_opening_balances'),('public.payroll_opening_employer_authorities'),
  ('public.payroll_opening_balance_components'),('public.payroll_opening_program_bases'),
  ('public.payroll_opening_account_bases'),('public.payroll_opening_sui_wages'),
  ('public.payroll_filing_accounts'),('public.files'),('public.file_versions'),
  ('public.payroll_filing_submissions')
 ) AS required(relation)
 WHERE to_regclass(required.relation) IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
