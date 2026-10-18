WITH findings AS (
 SELECT '0738.lifecycle_objects_exist'::text AS code,
  'Equity lifecycle objects exist without this migration being recorded'::text AS subject,
  'The migration adds MFN, interest, early-exercise, reversal and exchange-rate columns to the equity tables and the security amendment, interest run and compensation release tables.'::text AS detail,
  'Preserve the objects and every equity row; compare them with the reviewed migration and obtain the database owner’s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.equity_security_amendments') IS NOT NULL
  OR to_regclass('public.equity_interest_runs') IS NOT NULL
  OR to_regclass('public.equity_interest_run_lines') IS NOT NULL
  OR to_regclass('public.equity_compensation_run_releases') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.equity_securities') AND attname IN ('mfn', 'interest_day_count', 'unvested_repurchase_basis', 'fx_rate') AND NOT attisdropped)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.equity_security_events') AND attname IN ('reverses_event_id', 'interest_amount', 'deposit_amount', 'fx_rate') AND NOT attisdropped)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.equity_share_classes') AND attname IN ('conversion_share_class_id', 'conversion_adjusts_for_splits') AND NOT attisdropped)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.equity_account_policies') AND attname IN ('interest_expense_account_id', 'accrued_interest_account_id', 'early_exercise_deposit_account_id') AND NOT attisdropped)
 UNION ALL
 SELECT '0738.equity_tables_missing','The equity tables this migration extends are unavailable',
  'The migration extends the equity cap table tables published by migration 0733.',
  'Install the published migrations through the authorized native migration runner; preserve all equity history.'
 WHERE to_regclass('public.equity_securities') IS NULL
  OR to_regclass('public.equity_security_events') IS NULL
  OR to_regclass('public.equity_share_classes') IS NULL
  OR to_regclass('public.equity_class_amendments') IS NULL
  OR to_regclass('public.equity_account_policies') IS NULL
  OR to_regclass('public.equity_compensation_runs') IS NULL
  OR to_regprocedure('public.equity_record_immutable()') IS NULL
 UNION ALL
 SELECT '0738.query_catalog_missing','The query catalog refresh is unavailable',
  'The migration registers its tables in the governed query catalog and refreshes it.',
  'Install the published migrations through the authorized native migration runner; preserve all equity history.'
 WHERE to_regprocedure('public.openbooks_refresh_query_catalog()') IS NULL
  OR to_regclass('public.openbooks_query_catalog_relations') IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
