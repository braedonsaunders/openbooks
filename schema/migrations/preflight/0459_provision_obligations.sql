-- OpenBooks upgrade preflight for 0459_provision_obligations.
SELECT '0459.provision_catalog_conflict' AS code, 'refuse' AS severity,
       'Provision accounting objects' AS subject,
       'An object to be created already exists, or the financial-change domain guard is not uniquely identifiable.' AS detail,
       'Compare the catalog with the applied-migration ledger and reconcile the conflicting object before retrying the upgrade.' AS remedy
 WHERE to_regclass('public.provision_obligations') IS NOT NULL
    OR to_regprocedure('public.provision_identity_guard()') IS NOT NULL
    OR to_regprocedure('public.provision_change_binding_guard()') IS NOT NULL
    OR (SELECT count(*) FROM pg_constraint
        WHERE conrelid=to_regclass('public.financial_changes') AND contype='c'
          AND pg_get_constraintdef(oid) LIKE '%lease%revenue%asset%consolidation%manufacturing%') <> 1;
