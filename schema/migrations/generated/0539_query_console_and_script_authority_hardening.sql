-- OpenBooks forward migration 0539_query_console_and_script_authority_hardening.
--
-- 1. Query-console text execution. The governed console runs user SQL as
--    openbooks_read inside a READ ONLY transaction, but PostgreSQL grants
--    PUBLIC EXECUTE on catalog functions that run SQL supplied as a string
--    (query_to_xml and its family, ts_stat, ts_rewrite). SQL executed that way
--    can call set_config('role', 'none') and return the session to the
--    application login, which may then repoint the tenant setting at another
--    organization. None of these functions is used by the application, so
--    EXECUTE is revoked from PUBLIC and from every explicit grantee other than
--    the owner. A role that cannot revoke catalog privileges (the constrained
--    schema-owner mode) gets a WARNING naming the statement to run as a
--    superuser; the console itself refuses to run while openbooks_read can
--    still execute any of them.
-- 2. Canonical tenant policies. pay_component_department_expenses carried a
--    second permissive tenant policy beside the canonical org_isolation
--    policy, and payment_disputes was forced under row-level security without
--    enabling it and lost its policy version stamp when its policy was
--    re-created. Both tables now carry exactly the canonical stamped policy
--    with row-level security enabled and forced.
-- 3. Accountable script identity. user_scripts.run_as_user_id records the
--    user whose live permissions and entity scope govern a script's
--    privileged host calls when no signed-in caller drives the run
--    (scheduled, bulk and system-triggered runs). Existing scripts take the
--    last user the audit log records saving them; a script with no recorded
--    saver refuses privileged calls until it is saved again.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $query_console_text_execution$
DECLARE
  fn record;
  grantee_name text;
  revoke_statement text;
BEGIN
  FOR fn IN
    SELECT p.oid AS oid, p.proname AS proname, p.proowner AS proowner,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'pg_catalog'
       AND (p.proname IN (
              'query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema',
              'cursor_to_xml', 'cursor_to_xmlschema',
              'table_to_xml', 'table_to_xmlschema', 'table_to_xml_and_xmlschema',
              'schema_to_xml', 'schema_to_xmlschema', 'schema_to_xml_and_xmlschema',
              'database_to_xml', 'database_to_xmlschema', 'database_to_xml_and_xmlschema',
              'ts_stat', 'ts_rewrite'))
  LOOP
    FOR grantee_name IN
      SELECT CASE WHEN acl.grantee = 0 THEN 'public'
                  ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
        FROM pg_catalog.aclexplode(
               coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = fn.oid),
                        pg_catalog.acldefault('f', fn.proowner))) acl
       WHERE acl.privilege_type = 'EXECUTE' AND acl.grantee <> fn.proowner
    LOOP
      revoke_statement := format('revoke execute on function pg_catalog.%I(%s) from %s',
                                 fn.proname, fn.args, grantee_name);
      BEGIN
        EXECUTE revoke_statement;
      EXCEPTION
        WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    IF pg_catalog.to_regrole('openbooks_read') IS NOT NULL
       AND pg_catalog.has_function_privilege('openbooks_read', fn.oid, 'EXECUTE') THEN
      RAISE WARNING
        'query console hardening incomplete: openbooks_read can still execute pg_catalog.%(%), so the query console refuses to run. Run as a superuser: revoke execute on function pg_catalog.%(%) from public',
        fn.proname, fn.args, fn.proname, fn.args;
    END IF;
  END LOOP;
END
$query_console_text_execution$;

ALTER TABLE ONLY public.pay_component_department_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.pay_component_department_expenses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.pay_component_department_expenses;
DROP POLICY IF EXISTS org_isolation ON public.pay_component_department_expenses;
CREATE POLICY org_isolation ON public.pay_component_department_expenses
  USING ((SELECT public.app_bypass_rls_active())
      OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
      OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.pay_component_department_expenses IS 'openbooks:org_isolation:v1';

ALTER TABLE ONLY public.payment_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.payment_disputes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.payment_disputes;
CREATE POLICY org_isolation ON public.payment_disputes
  USING ((SELECT public.app_bypass_rls_active())
      OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active())
      OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.payment_disputes IS 'openbooks:org_isolation:v1';

ALTER TABLE public.user_scripts ADD COLUMN run_as_user_id uuid;
COMMENT ON COLUMN public.user_scripts.run_as_user_id IS
  'User whose live permissions and entity scope govern privileged host calls when no signed-in caller drives the run; set to the user who last saved or promoted the script. Null refuses privileged calls on such runs.';

UPDATE public.user_scripts s
   SET run_as_user_id = saver.actor_id
  FROM (
    SELECT DISTINCT ON (a.org_id, a.row_id) a.org_id, a.row_id, a.actor_id
      FROM public.audit_log a
      JOIN public.users u ON u.id = a.actor_id AND u.org_id = a.org_id
     WHERE a.table_name = 'user_scripts' AND a.action IN ('insert', 'update')
     ORDER BY a.org_id, a.row_id, a.at DESC, a.id DESC
  ) saver
 WHERE saver.org_id = s.org_id AND saver.row_id = s.id;
