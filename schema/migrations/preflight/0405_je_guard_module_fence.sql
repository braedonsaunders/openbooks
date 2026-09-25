-- OpenBooks upgrade preflight for 0405_je_guard_module_fence.
--
-- Read-only mirror of the migration's own preflight: the live
-- public.je_guard() body must still be the 0400 shape the restore was
-- authored against (the draft-post block is present, the 0168 v_module
-- branch is not). A reshaped guard means this install diverged from the
-- baseline, and replacing it blind would drop the divergence; a body that
-- already names v_module means the restore is superseded. Zero rows means
-- ready: 0405 will add only the branch.
-- Jump upgrades whose base predates 0400 yield zero rows here: that body is
-- ancestral, not diverged — 0400 restores it before 0405 applies, and 0405's
-- own in-migration preflight verifies the shape then.
SELECT '0405.unexpected_je_guard' AS code,
       'refuse' AS severity,
       'function public.je_guard()' AS subject,
       left(pg_catalog.pg_get_functiondef('public.je_guard()'::regprocedure), 500) AS detail,
       'Rebase the 0405 guard restore on the live body before upgrading.' AS remedy
  FROM pg_catalog.pg_proc p
 WHERE p.oid = 'public.je_guard()'::regprocedure
   AND EXISTS (
         select 1
           from public._applied_migrations
          where filename = 'generated/0400_ledger_guard_reversal_and_clone_authority.sql'
       )
   AND (pg_catalog.pg_get_functiondef(p.oid) NOT LIKE '%Branch: draft-post (f2/0168 owns the source-module recheck inside this block)%'
        OR pg_catalog.pg_get_functiondef(p.oid) LIKE '%v_module%');
