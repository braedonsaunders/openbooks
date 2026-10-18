WITH findings AS (
 SELECT '0742.equity_objects_exist'::text AS code,
  'Equity action request or position ledger objects exist without this migration being recorded'::text AS subject,
  'The migration adds the equity action request table, the cap table position-movements ledger, their guards and the position backfill functions.'::text AS detail,
  'Preserve the objects and every equity row; compare them with the reviewed migration and obtain the database owner’s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.equity_action_requests') IS NOT NULL
  OR to_regclass('public.equity_position_movements') IS NOT NULL
  OR to_regprocedure('public.equity_action_request_guard()') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'equity\_position\_%')
 UNION ALL
 SELECT '0742.equity_tables_missing','The equity tables this migration reads are unavailable',
  'The migration backfills the position ledger from the equity cap table history published by migrations 0733 and 0738.',
  'Install the published migrations through the authorized native migration runner; preserve all equity history.'
 WHERE to_regclass('public.equity_securities') IS NULL
  OR to_regclass('public.equity_security_events') IS NULL
  OR to_regclass('public.equity_share_classes') IS NULL
  OR to_regclass('public.equity_class_amendments') IS NULL
  OR to_regclass('public.equity_splits') IS NULL
  OR to_regclass('public.equity_plans') IS NULL
  OR to_regclass('public.equity_plan_reserve_changes') IS NULL
  OR to_regprocedure('public.equity_record_immutable()') IS NULL
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.equity_share_classes') AND attname = 'conversion_share_class_id' AND NOT attisdropped)
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.equity_security_events') AND attname = 'reverses_event_id' AND NOT attisdropped)
 UNION ALL
 SELECT '0742.tenant_guards_missing','The tenant retirement and sandbox guards are unavailable',
  'The migration fences its tables for tenant retirement and lets an approved sandbox wipe remove equity action requests.',
  'Install the published migrations through the authorized native migration runner; preserve all equity history.'
 WHERE to_regprocedure('tenant_retirement.openbooks_tenant_retirement_fence()') IS NULL
  OR to_regprocedure('tenant_retirement.openbooks_tenant_retirement_delete_allowed(text,jsonb)') IS NULL
  OR to_regprocedure('public.openbooks_sandbox_wipe_allowed(uuid)') IS NULL
  OR to_regprocedure('public.app_bypass_rls_active()') IS NULL
 UNION ALL
 SELECT '0742.query_catalog_missing','The query catalog refresh is unavailable',
  'The migration registers its tables in the governed query catalog and refreshes it.',
  'Install the published migrations through the authorized native migration runner; preserve all equity history.'
 WHERE to_regprocedure('public.openbooks_refresh_query_catalog()') IS NULL
  OR to_regclass('public.openbooks_query_catalog_relations') IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
