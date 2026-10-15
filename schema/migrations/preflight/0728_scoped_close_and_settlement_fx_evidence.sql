WITH findings AS (
 SELECT '0728.evidence_table_exists'::text AS code,
  'Closing exchange rate evidence exists without this migration being recorded'::text AS subject,
  'The migration creates the append-only closing rate evidence table, its position, successor and request indexes, and its storage guard.'::text AS detail,
  'Preserve the table and every recorded observation; compare them with the reviewed migration and obtain the database owner’s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.fx_revaluation_rate_evidence') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
   WHERE tgname IN ('fx_revaluation_rate_evidence_guard', 'fx_revaluation_rate_evidence_audit') AND NOT tgisinternal)
 UNION ALL
 SELECT '0728.evidence_function_exists','A closing exchange rate evidence function exists without this migration being recorded',
  'The migration creates the storage guard that binds each observation to its book, legal entity, period, monetary account and book measurement currency, and the audit writer for recorded observations.',
  'Preserve the functions and tenant data; compare complete definitions with the reviewed migration and obtain the database owner’s approval before reconciliation.'
 WHERE to_regprocedure('public.fx_revaluation_rate_evidence_guard()') IS NOT NULL
  OR to_regprocedure('public.fx_revaluation_rate_evidence_audit()') IS NOT NULL
  OR to_regprocedure('public.fx_revaluation_rate_evidence_clone_matches(jsonb)') IS NOT NULL
 UNION ALL
 SELECT '0728.settlement_evidence_already_extended','Document rate evidence already admits settlement documents without this migration being recorded',
  'The migration replaces the document evidence binding so customer and vendor payments may carry recorded rate evidence on the same exact terms as invoices and bills.',
  'Preserve the constraint and every document row; compare its complete definition with the reviewed migration and obtain the database owner’s approval before reconciliation.'
 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
   WHERE conrelid = to_regclass('public.documents') AND conname = 'documents_fx_rate_evidence_bound'
     AND pg_get_constraintdef(oid) LIKE '%customer_payment%')
 UNION ALL
 SELECT '0728.document_evidence_prerequisite_missing',required.subject,
  'Settlement evidence extends the existing document evidence column and binding; without them there is nothing to extend.',
  'Install the published document exchange rate evidence migration through the authorized native migration runner; preserve all document history.'
 FROM (VALUES
  ('public.documents',to_regclass('public.documents') IS NOT NULL),
  ('public.documents.document_fx_rate_evidence',EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.documents') AND attname = 'document_fx_rate_evidence' AND NOT attisdropped)),
  ('public.documents.documents_fx_rate_evidence_bound',EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
   WHERE conrelid = to_regclass('public.documents') AND conname = 'documents_fx_rate_evidence_bound'))
 ) AS required(subject,present)
 WHERE NOT required.present
 UNION ALL
 SELECT '0728.book_measurement_prerequisite_missing','The native book measurement currency contract is unavailable',
  'Closing evidence binds the currency the selected book measures its legal entity in, resolved through the native book currency function.',
  'Install the published accounting book currency migration through the authorized native migration runner; preserve tenant history.'
 WHERE to_regprocedure('public.accounting_book_currency(uuid,uuid,uuid)') IS NULL
  OR to_regclass('public.accounting_books') IS NULL
  OR to_regclass('public.accounting_periods') IS NULL
 UNION ALL
 SELECT '0728.reference_table_missing','A table the closing rate evidence binds to is unavailable',
  'Each observation holds organization, book, legal entity, period, account, currency and actor references, and copied evidence resolves its sandbox control row, so the organizations, users, subsidiaries, accounts, currencies and sandboxes tables must already exist.',
  'Install the published baseline migrations through the authorized native migration runner; preserve all tenant history.'
 WHERE to_regclass('public.orgs') IS NULL
  OR to_regclass('public.users') IS NULL
  OR to_regclass('public.subsidiaries') IS NULL
  OR to_regclass('public.accounts') IS NULL
  OR to_regclass('public.currencies') IS NULL
  OR to_regclass('public.sandboxes') IS NULL
 UNION ALL
 SELECT '0728.clone_contract_missing','The native clone authority or identity rebasing contract is unavailable',
  'Copied closing rate evidence is admitted only under native clone authority against the registered sandbox source, with every identity rebased to the destination.',
  'Install the published clone authority migrations through the authorized native migration runner; preserve tenant history.'
 WHERE to_regprocedure('public.openbooks_clone_authority()') IS NULL
  OR to_regprocedure('public.ob_rebase(uuid,uuid)') IS NULL
 UNION ALL
 SELECT '0728.retirement_wipe_contract_missing','The tenant retirement or sandbox wipe contract is unavailable',
  'Recorded closing rate evidence deletes only through the approved tenant-retirement and sandbox-wipe controls, and its storage fence is the native retirement fence.',
  'Install the published tenant retirement and sandbox wipe migrations through the authorized native migration runner; preserve tenant history.'
 WHERE to_regprocedure('tenant_retirement.openbooks_tenant_retirement_delete_allowed(text,jsonb)') IS NULL
  OR to_regprocedure('tenant_retirement.openbooks_tenant_retirement_fence()') IS NULL
  OR to_regprocedure('public.openbooks_sandbox_wipe_allowed(uuid)') IS NULL
 UNION ALL
 SELECT '0728.query_catalog_missing','The query catalog refresh is unavailable',
  'The migration refreshes the query catalog after extending the document evidence binding.',
  'Install the published baseline migrations through the authorized native migration runner; preserve all document history.'
 WHERE to_regprocedure('public.openbooks_refresh_query_catalog()') IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
