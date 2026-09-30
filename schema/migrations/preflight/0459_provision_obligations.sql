-- OpenBooks upgrade preflight for 0459_provision_obligations.
-- The manufacturing snapshot migration extends the domain guard immediately
-- before this migration. Require its snapshot column so older installations
-- defer this check until that pending migration has run, then verify the
-- extended guard and all object conflicts before applying provisions.
SELECT '0459.provision_catalog_conflict' AS code, 'refuse' AS severity,
       'Provision accounting objects' AS subject,
       'An object to be created already exists, or the financial-change domain guard is not uniquely identifiable.' AS detail,
       'Compare the catalog with the applied-migration ledger and reconcile the conflicting object before retrying the upgrade.' AS remedy
 WHERE (SELECT count(*) FROM (SELECT treatment FROM public.mfg_scrap_events LIMIT 0) AS prerequisite) = 0
   AND (to_regclass('public.provision_obligations') IS NOT NULL
    OR to_regprocedure('public.provision_identity_guard()') IS NOT NULL
    OR to_regprocedure('public.provision_change_binding_guard()') IS NOT NULL
    OR (SELECT count(*) FROM pg_constraint
        WHERE conrelid='public.financial_changes'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) LIKE '%lease%revenue%asset%consolidation%manufacturing%') <> 1);
