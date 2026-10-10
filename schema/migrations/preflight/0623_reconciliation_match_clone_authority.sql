SELECT '0623.reconciliation_match_guard_contract' AS code, 'refuse' AS severity,
       'public.openbooks_reconciliation_match_guard()' AS subject,
       'The reconciliation match guard differs from its published function contract.' AS detail,
       'Preserve the existing function and reconcile its definition and migration ledger before upgrading.' AS remedy
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = pg_catalog.to_regprocedure('public.openbooks_reconciliation_match_guard()')
      AND md5(p.prosrc) = 'c8d28d78f47ae26052eb9eb9dfbb2941'
      AND p.prorettype = 'pg_catalog.trigger'::regtype
      AND p.prosecdef = false
      AND p.proconfig IS NULL
 );
