-- OpenBooks upgrade preflight for 0399_rls_bypass_role_predicate.
--
-- Read-only mirror of the migration's closing assertion, narrowed to what
-- the migration cannot fix itself: policy expressions that trust the raw
-- app.bypass_rls GUC in a form OTHER than the canonical stored spelling
-- 0399 rewrites (current_setting('app.bypass_rls'::text, true) = 'on'::text —
-- the parser normalizes every authored variant to it, so survivors here are
-- hand-made policies or unknown spellings). The canonical form is stripped
-- before matching; any remaining app.bypass_rls reference refuses the
-- upgrade by name. Zero rows means ready: 0399 will rewrite the rest.
SELECT '0399.unrecognized_bypass_expression' AS code,
       'refuse' AS severity,
       format('policy %s on %s.%s trusts app.bypass_rls outside the 0399 rewrite',
              p.policyname, p.schemaname, p.tablename) AS subject,
       left(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''), 500) AS detail,
       'Rewrite that policy arm as public.app_bypass_rls_active() (or to the canonical current_setting form 0399 handles) before upgrading.' AS remedy
  FROM pg_policies p
 WHERE replace(
         replace(
           coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
           'current_setting(''app.bypass_rls''::text, true) = ''on''::text',
           ''),
         'current_setting(''app.bypass_rls'', true) = ''on''',
         '') LIKE '%app.bypass_rls%'
 ORDER BY p.schemaname, p.tablename, p.policyname
 LIMIT 20;
