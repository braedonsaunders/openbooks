-- The equity history this migration backfills from must carry the columns 0738
-- adds; referencing them directly lets the runner defer this check while 0738
-- is pending in the same upgrade, and fail loudly when it is genuinely absent.
WITH required_equity_history AS (
 SELECT (SELECT count(*) FROM (SELECT reverses_event_id FROM public.equity_security_events LIMIT 0) events)
  + (SELECT count(*) FROM (SELECT conversion_share_class_id FROM public.equity_share_classes LIMIT 0) classes)
  + (SELECT count(*) FROM (SELECT 1 FROM public.equity_class_amendments, public.equity_splits, public.equity_plans, public.equity_plan_reserve_changes LIMIT 0) history) AS present
),
findings AS (
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
