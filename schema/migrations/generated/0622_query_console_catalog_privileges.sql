-- Restrict SQL-text execution functions to their owners so governed read-only
-- queries cannot invoke a second SQL interpreter outside query validation.
-- Catalog privilege administration requires a PostgreSQL superuser.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $query_console_catalog_privileges$
DECLARE
  fn record;
  grantee_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = SESSION_USER AND rolsuper
  ) THEN
    RAISE EXCEPTION 'Query-console catalog hardening requires a PostgreSQL superuser migration login';
  END IF;

  FOR fn IN
    SELECT p.oid, p.proname, p.proowner,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           p.proacl
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'pg_catalog'
       AND p.proname IN (
         'query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema',
         'cursor_to_xml', 'cursor_to_xmlschema',
         'table_to_xml', 'table_to_xmlschema', 'table_to_xml_and_xmlschema',
         'schema_to_xml', 'schema_to_xmlschema', 'schema_to_xml_and_xmlschema',
         'database_to_xml', 'database_to_xmlschema', 'database_to_xml_and_xmlschema',
         'ts_stat', 'ts_rewrite'
       )
     ORDER BY p.oid
  LOOP
    FOR grantee_name IN
      SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                  ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END
        FROM pg_catalog.aclexplode(
          coalesce(fn.proacl, pg_catalog.acldefault('f', fn.proowner))
        ) acl
       WHERE acl.privilege_type = 'EXECUTE' AND acl.grantee <> fn.proowner
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION pg_catalog.%I(%s) FROM %s CASCADE',
                     fn.proname, fn.args, grantee_name);
    END LOOP;

    IF pg_catalog.to_regrole('openbooks_read') IS NOT NULL
       AND pg_catalog.has_function_privilege('openbooks_read', fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Query-console hardening incomplete for pg_catalog.%(%)', fn.proname, fn.args;
    END IF;
  END LOOP;
END
$query_console_catalog_privileges$;
