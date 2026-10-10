SELECT '0625.quota_guard_contract' AS code,'refuse' AS severity,
       'public.sales_quota_version_guard()' AS subject,
       'The quota guard differs from its published contract.' AS detail,
       'Preserve its definition and migration ledger; reconcile them before upgrading.' AS remedy
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid=pg_catalog.to_regprocedure('public.sales_quota_version_guard()')
      AND md5(p.prosrc)='44e706de23a2793b089994d8023f3eff'
      AND p.prorettype='pg_catalog.trigger'::regtype AND NOT p.prosecdef
      AND p.proconfig=ARRAY['search_path=public, pg_catalog']::text[]
 );
