-- OpenBooks upgrade preflight for 0418_table_driven_module_registries.
--
-- Read-only mirror of the migration's own seed check: the live
-- public.openbooks_refresh_query_catalog() body must still carry the
-- safe_relations array literal the 0418 seed was authored against, with at
-- least one relation name in it. An unparseable body means this install
-- diverged from every known shape, and seeding the registry blind would
-- enshrine the divergence; zero rows means ready.
SELECT '0418.unparseable_query_catalog' AS code,
       'refuse' AS severity,
       'function public.openbooks_refresh_query_catalog()' AS subject,
       left(pg_catalog.pg_get_functiondef('public.openbooks_refresh_query_catalog()'::regprocedure), 300) AS detail,
       'Rebase the 0418 registry seed on the live function body before upgrading.' AS remedy
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'public.openbooks_refresh_query_catalog()'::regprocedure
   AND pg_catalog.pg_get_functiondef(p.oid) !~ 'safe_relations constant text\[\] := array\[(?:.|\n)*?''[a-z_][a-z0-9_]*''';
