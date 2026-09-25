-- OpenBooks upgrade preflight for 0402_rls_bypass_trigger_bodies.
--
-- Read-only mirror of the migration's closing assertion, narrowed to what
-- the migration cannot fix itself: function/trigger bodies that read the raw
-- app.bypass_rls GUC in a form OTHER than the comparisons 0402 rewrites
-- (plain, ::text-cast, and coalesce-wrapped current_setting = 'on', any
-- spacing or keyword case). Those handled forms are stripped before
-- matching; any remaining raw read refuses the upgrade by name.
-- public.openbooks_clone_authority() is owned by arch-ledger (0401 recut)
-- and public.app_bypass_rls_active() reads the GUC by design, so neither is
-- listed here. Zero rows means ready: 0402 will rewrite the rest.
SELECT '0402.unrecognized_bypass_body' AS code,
       'refuse' AS severity,
       format('function %s.%s trusts app.bypass_rls outside the 0402 rewrite',
              q.schemaname, q.funcname) AS subject,
       left(q.def, 500) AS detail,
       'Rewrite that body arm as public.app_bypass_rls_active() before upgrading.' AS remedy
  FROM (SELECT n.nspname AS schemaname, p.proname AS funcname,
               pg_catalog.pg_get_functiondef(p.oid) AS def
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'openbooks_query')
           AND p.prokind IN ('f', 'p')
           AND p.proname NOT IN ('app_bypass_rls_active', 'openbooks_clone_authority')
           AND NOT EXISTS (
                 SELECT 1
                   FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_proc'::regclass
                    AND d.objid = p.oid
                    AND d.deptype = 'e'
               )) q
 WHERE replace(
         replace(
           replace(q.def,
             'current_setting(''app.bypass_rls'', true) = ''on''', ''),
           'current_setting(''app.bypass_rls''::text, true) = ''on''::text', ''),
         'coalesce(current_setting(''app.bypass_rls'', true), ''off'') = ''on''', '')
       LIKE '%app.bypass_rls%'
 ORDER BY q.schemaname, q.funcname
 LIMIT 20;
