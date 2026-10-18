SELECT '0754.non_native_fence'::text AS code,
 'public.'||c.relname AS subject,
 'A tenant_retirement_fence trigger exists on this table but is not the native retirement fence.'::text AS detail,
 'Preserve the trigger and tenant data; compare its complete definition with the native fence and obtain the database owner’s approval before reconciliation.'::text AS remedy
 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND t.tgname='tenant_retirement_fence' AND NOT t.tgisinternal
   AND (t.tgfoid IS DISTINCT FROM to_regprocedure('tenant_retirement.openbooks_tenant_retirement_fence()')::oid
     OR t.tgtype::integer<>CASE WHEN c.relname='orgs' THEN 27 ELSE 31 END OR t.tgenabled NOT IN ('O','A'))
 ORDER BY 2
