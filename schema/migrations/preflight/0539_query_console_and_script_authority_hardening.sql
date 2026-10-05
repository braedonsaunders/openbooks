SELECT '0539.catalog_privilege_needs_superuser' AS code, 'notice' AS severity, p.oid::regprocedure::text AS subject,
 'PUBLIC can execute this SQL-string function and the migration role cannot withdraw that privilege, so the query console will refuse to run after the upgrade.' AS detail,
 'Have a superuser withdraw EXECUTE on this function from PUBLIC (the migration warning prints the exact statement), then retry the query console.' AS remedy
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'pg_catalog'
  AND p.proname IN (
    'query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema',
    'cursor_to_xml', 'cursor_to_xmlschema',
    'table_to_xml', 'table_to_xmlschema', 'table_to_xml_and_xmlschema',
    'schema_to_xml', 'schema_to_xmlschema', 'schema_to_xml_and_xmlschema',
    'database_to_xml', 'database_to_xmlschema', 'database_to_xml_and_xmlschema',
    'ts_stat', 'ts_rewrite')
  AND pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
  AND NOT pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE')
  AND NOT coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)
UNION ALL
SELECT '0539.script_without_saver' AS code, 'notice' AS severity, s.name::text AS subject,
 'No user is recorded saving this active script, so its scheduled, bulk and system-triggered runs will refuse queries and journal writes.' AS detail,
 'After the upgrade, open the script and save it as a user who holds the permissions it uses.' AS remedy
FROM public.user_scripts s
WHERE s.is_active
  AND NOT EXISTS (
    SELECT 1 FROM public.audit_log a
      JOIN public.users u ON u.id = a.actor_id AND u.org_id = a.org_id
     WHERE a.table_name = 'user_scripts' AND a.row_id = s.id AND a.org_id = s.org_id
       AND a.action IN ('insert', 'update'));
