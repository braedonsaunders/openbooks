SELECT '0622.catalog_privilege_authority' AS code, 'refuse' AS severity,
       SESSION_USER::text AS subject,
       'The migration login cannot administer PostgreSQL catalog function privileges.' AS detail,
       'Run the native migration runner with a PostgreSQL superuser migration login; keep application and read-only roles unchanged.' AS remedy
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = SESSION_USER AND rolsuper
 );
