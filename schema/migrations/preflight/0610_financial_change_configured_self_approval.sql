SELECT '0610.accounting_approval_catalog_conflict' AS code, 'refuse' AS severity,
       'Accounting event approval policy' AS subject,
       'The independent-review constraint differs from its published definition, or an approval-policy object exists without this migration.' AS detail,
       'Compare the catalog with the published migration ledger and reconcile the conflicting object before upgrading.' AS remedy
 WHERE (SELECT count(*) FROM (SELECT id FROM public.payroll_holiday_obligations LIMIT 0) AS prerequisite)=0
   AND (to_regprocedure('public.financial_change_self_decision_authorized(uuid,uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.financial_change_self_decision_guard()') IS NOT NULL
     OR to_regprocedure('public.financial_change_clone_context(jsonb,uuid)') IS NOT NULL
     OR NOT EXISTS(SELECT 1 FROM pg_constraint
       WHERE conrelid='public.financial_changes'::regclass AND conname='financial_changes_check' AND contype='c'
         AND regexp_replace(pg_get_expr(conbin,conrelid),'[()[:space:]]','','g')='approved_byISNULLORapproved_by<>submitted_by'));
