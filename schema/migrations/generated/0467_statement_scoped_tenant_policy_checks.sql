-- Evaluate statement-constant tenant context and bypass checks once without
-- changing privilege requirements or the row-specific organization predicate.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Qualify function names in deparsed policies so only the authoritative
-- function is rewritten, including in installations with other schemas.
SELECT pg_catalog.set_config('search_path', 'pg_catalog', false);

DO $migration$
DECLARE
  policy record;
  using_before text;
  check_before text;
  using_after text;
  check_after text;
BEGIN
  FOR policy IN
    SELECT p.polname, p.polrelid, p.polqual, p.polwithcheck,
           n.nspname, c.relname
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'openbooks_query')
     ORDER BY n.nspname, c.relname, p.polname
  LOOP
    using_before := pg_catalog.pg_get_expr(policy.polqual, policy.polrelid);
    check_before := pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid);
    -- pg_get_expr renders an existing scalar subquery as SELECT followed by
    -- the qualified call. Excluding that form makes replay idempotent.
    using_after := pg_catalog.regexp_replace(using_before,
      '(?<!SELECT )public\.app_bypass_rls_active\(\)',
      '(SELECT public.app_bypass_rls_active())', 'g');
    check_after := pg_catalog.regexp_replace(check_before,
      '(?<!SELECT )public\.app_bypass_rls_active\(\)',
      '(SELECT public.app_bypass_rls_active())', 'g');
    using_after := pg_catalog.regexp_replace(using_after,
      '(?<!SELECT )current_setting\(''app\.current_org''::text, true\)',
      '(SELECT current_setting(''app.current_org'', true))', 'g');
    check_after := pg_catalog.regexp_replace(check_after,
      '(?<!SELECT )current_setting\(''app\.current_org''::text, true\)',
      '(SELECT current_setting(''app.current_org'', true))', 'g');
    IF using_after IS DISTINCT FROM using_before OR check_after IS DISTINCT FROM check_before THEN
      EXECUTE pg_catalog.format('ALTER POLICY %I ON %I.%I%s%s',
        policy.polname, policy.nspname, policy.relname,
        CASE WHEN using_after IS NULL THEN '' ELSE ' USING (' || using_after || ')' END,
        CASE WHEN check_after IS NULL THEN '' ELSE ' WITH CHECK (' || check_after || ')' END);
    END IF;
  END LOOP;
END
$migration$;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);
