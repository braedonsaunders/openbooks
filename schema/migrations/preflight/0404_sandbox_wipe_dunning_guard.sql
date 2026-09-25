-- OpenBooks upgrade preflight for 0404_sandbox_wipe_dunning_guard.
--
-- Read-only mirror of the migration's own preflight: the live
-- public.dunning_log_guard() body must still be the 0402 shape (the bypass
-- arm calls the role-gated predicate, DELETE is refused unconditionally,
-- no wipe exemption yet). A reshaped body means this install diverged from
-- the baseline 0404 was authored against, and replacing it blind would drop
-- the divergence. Zero rows means ready: 0404 will add only the exemption.
-- Jump upgrades whose base predates 0402 yield zero rows here: that body is
-- ancestral, not diverged — 0402 reshapes it before 0404 applies, and 0404's
-- own in-migration preflight verifies the shape then.
SELECT '0404.unexpected_dunning_guard' AS code,
       'refuse' AS severity,
       'function public.dunning_log_guard()' AS subject,
       left(pg_catalog.pg_get_functiondef('public.dunning_log_guard()'::regprocedure), 500) AS detail,
       'Rebase the 0404 guard replacement on the live body before upgrading.' AS remedy
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'public.dunning_log_guard()'::regprocedure
   AND EXISTS (
         select 1
           from public._applied_migrations
          where filename = 'generated/0402_rls_bypass_trigger_bodies.sql'
       )
   AND (pg_catalog.pg_get_functiondef(p.oid) NOT LIKE '%public.app_bypass_rls_active()%'
        OR pg_catalog.pg_get_functiondef(p.oid) LIKE '%app.bypass_rls%'
        OR pg_catalog.pg_get_functiondef(p.oid) LIKE '%openbooks_sandbox_wipe_allowed%');
