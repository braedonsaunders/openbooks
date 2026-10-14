WITH findings AS (
 SELECT '0727.evidence_column_exists'::text AS code,
  'Document exchange rate evidence exists without this migration being recorded'::text AS subject,
  'The migration adds the nullable evidence column, its binding constraint and the trigger that freezes it outside draft.'::text AS detail,
  'Preserve the column, its constraint, trigger and every document row; compare them with the reviewed migration and obtain the database owner’s approval before reconciliation.'::text AS remedy
 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid=to_regclass('public.documents') AND attname='document_fx_rate_evidence' AND NOT attisdropped)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
   WHERE conrelid=to_regclass('public.documents') AND conname='documents_fx_rate_evidence_bound')
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
   WHERE tgrelid=to_regclass('public.documents') AND tgname IN ('documents_fx_rate_evidence_frozen','documents_fx_rate_evidence_insert') AND NOT tgisinternal)
 UNION ALL
 SELECT '0727.evidence_function_exists','A document exchange rate evidence function exists without this migration being recorded',
  'The migration creates the clone projection, the clone source comparison, the insert guard and the guard freezing evidence outside draft, and extends sales source matching with the evidence.',
  'Preserve the functions and tenant data; compare complete definitions with the reviewed migration and obtain the database owner’s approval before reconciliation.'
 WHERE to_regprocedure('public.document_fx_rate_evidence_for_clone(jsonb,uuid,boolean)') IS NOT NULL
  OR to_regprocedure('public.document_fx_rate_evidence_clone_matches(public.documents)') IS NOT NULL
  OR to_regprocedure('public.document_fx_rate_evidence_insert_guard()') IS NOT NULL
  OR to_regprocedure('public.document_fx_rate_evidence_frozen_guard()') IS NOT NULL
 UNION ALL
 SELECT '0727.query_catalog_missing','The query catalog refresh is unavailable',
  'The migration refreshes the query catalog so reports see the evidence column.',
  'Install the published baseline migrations through the authorized native migration runner; preserve all document history.'
 WHERE to_regprocedure('public.openbooks_refresh_query_catalog()') IS NULL
 UNION ALL
 SELECT '0727.clone_contract_missing','The native clone authority or sales source matching contract is unavailable',
  'Copied evidence is admitted only under native clone authority against the registered sandbox source, and sales source matching is redefined to include it.',
  'Install the published clone authority and sales clone matching migrations through the authorized native migration runner; preserve tenant history.'
 WHERE to_regprocedure('public.openbooks_clone_authority()') IS NULL
  OR to_regprocedure('public.ob_rebase(uuid,uuid)') IS NULL
  OR to_regprocedure('public.sales_document_clone_matches(public.documents)') IS NULL
  OR to_regclass('public.sandboxes') IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
