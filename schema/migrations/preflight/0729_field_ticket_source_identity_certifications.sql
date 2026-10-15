WITH findings AS (
 SELECT '0729.certification_table_exists'::text AS code,
  'Field Ticket source-identity certifications exist without this migration being recorded'::text AS subject,
  'The migration creates the append-only certification table, its source, native-ticket and request unique indexes, and its storage guard.'::text AS detail,
  'Preserve the table and every certification; compare them with the reviewed migration and obtain the database owner’s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.field_ticket_source_certifications') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
   WHERE tgname IN ('field_ticket_source_certification_guard', 'field_ticket_source_certification_audit', 'tenant_retirement_fence') AND NOT tgisinternal
     AND tgrelid = to_regclass('public.field_ticket_source_certifications'))
 UNION ALL
 SELECT '0729.certification_function_exists','A Field Ticket source-identity certification function exists without this migration being recorded',
  'The migration creates the storage guard that binds each certification to its exact native ticket and retained file version, the audit writer, the sandbox clone matcher, and the document source-projection guard.',
  'Preserve the functions and tenant data; compare complete definitions with the reviewed migration and obtain the database owner’s approval before reconciliation.'
 WHERE to_regprocedure('public.field_ticket_source_certification_guard()') IS NOT NULL
  OR to_regprocedure('public.field_ticket_source_certification_audit()') IS NOT NULL
  OR to_regprocedure('public.field_ticket_source_certifications_clone_matches(jsonb)') IS NOT NULL
  OR to_regprocedure('public.field_ticket_source_projection_guard()') IS NOT NULL
  OR to_regprocedure('public.field_ticket_source_certification_projection_commit()') IS NOT NULL
  OR to_regprocedure('public.field_ticket_source_certification_clone_evidence(jsonb,uuid,text,uuid,boolean)') IS NOT NULL
 UNION ALL
 SELECT '0729.source_projection_already_guarded','The Field Ticket document source projection is already guarded without this migration being recorded',
  'The migration installs the projection guard so a stored source marker can be set only from a governed certification for that exact ticket.',
  'Preserve the trigger and every document row; compare its complete definition with the reviewed migration and obtain the database owner’s approval before reconciliation.'
 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
   WHERE tgname = 'field_ticket_source_projection_guard' AND NOT tgisinternal
     AND tgrelid = to_regclass('public.documents'))
 UNION ALL
 SELECT '0729.native_ticket_prerequisite_missing','The native Field Ticket records this migration certifies are unavailable',
  'Certification binds a documents row of kind field_ticket and its one-to-one native Field Ticket header; without them there is nothing to certify.',
  'Install the published Field Ticket migrations through the authorized native migration runner; preserve all document history.'
 WHERE to_regclass('public.documents') IS NULL
  OR to_regclass('public.field_tickets') IS NULL
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.documents') AND attname = 'revision_seq' AND NOT attisdropped)
 UNION ALL
 SELECT '0729.retained_file_prerequisite_missing','The retained source file contract this migration pins is unavailable',
  'Certification pins an exact Cabinet file and version by their recorded content hash, resolved through the native file and file-version tables.',
  'Install the published File Cabinet migrations through the authorized native migration runner; preserve all retained files.'
 WHERE to_regclass('public.files') IS NULL
  OR to_regclass('public.file_versions') IS NULL
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index
   WHERE indrelid = to_regclass('public.file_versions')
     AND indisunique AND indisvalid AND indisready
     AND pg_get_indexdef(indexrelid) LIKE '%(file_id, id)%')
 UNION ALL
 SELECT '0729.clone_prerequisite_missing','The native sandbox clone contract is unavailable',
  'Certification copies are admitted only as the exact rebased projection of a registered sandbox source, computed through the native clone authority and evidence projection.',
  'Install the published sandbox clone migrations through the authorized native migration runner; preserve tenant history.'
 WHERE to_regprocedure('public.openbooks_clone_authority()') IS NULL
  OR to_regprocedure('public.production_clone_safe_evidence(jsonb,uuid,text,uuid,boolean)') IS NULL
  OR to_regprocedure('public.ob_rebase(uuid,uuid)') IS NULL
 UNION ALL
 SELECT '0729.tenant_identity_prerequisite_missing','A tenant identity table this migration binds is unavailable',
  'Certifications reference the organization, the certifying user, the native project and legal entity, and a sandbox copy resolves its source organization through the sandbox registry.',
  'Install the published organization, identity, project and sandbox migrations through the authorized native migration runner; preserve tenant history.'
 WHERE to_regclass('public.orgs') IS NULL
  OR to_regclass('public.users') IS NULL
  OR to_regclass('public.projects') IS NULL
  OR to_regclass('public.subsidiaries') IS NULL
  OR to_regclass('public.sandboxes') IS NULL
 UNION ALL
 SELECT '0729.audit_prerequisite_missing','The audit log this migration writes is unavailable',
  'The certification audit writer and the commit-time projection check both resolve the retained audit log by organization, table, row, actor and request.',
  'Install the published baseline migrations through the authorized native migration runner; preserve all audit history.'
 WHERE to_regclass('public.audit_log') IS NULL
 UNION ALL
 SELECT '0729.retirement_prerequisite_missing','The tenant-retirement delete and fence contract is unavailable',
  'Certification rows may be deleted only through the governed tenant-retirement control, and every insert carries its retirement fence, resolved through the native retirement delete predicate and fence function.',
  'Install the published tenant-retirement migrations through the authorized native migration runner; preserve tenant history.'
 WHERE to_regprocedure('tenant_retirement.openbooks_tenant_retirement_delete_allowed(text,jsonb)') IS NULL
  OR to_regprocedure('tenant_retirement.openbooks_tenant_retirement_fence()') IS NULL
 UNION ALL
 SELECT '0729.sandbox_wipe_prerequisite_missing','The sandbox-wipe, row-security or identity contract is unavailable',
  'Certification rows may be removed inside an approved sandbox wipe, their row-level security resolves the native bypass predicate, and new rows mint their identity through the native uuid generator.',
  'Install the published baseline and sandbox migrations through the authorized native migration runner; preserve tenant history.'
 WHERE to_regprocedure('public.openbooks_sandbox_wipe_allowed(uuid)') IS NULL
  OR to_regprocedure('public.app_bypass_rls_active()') IS NULL
  OR to_regprocedure('public.uuid_generate_v7()') IS NULL
 UNION ALL
 SELECT '0729.query_catalog_missing','The query catalog refresh is unavailable',
  'The migration refreshes the query catalog after creating the certification table.',
  'Install the published baseline migrations through the authorized native migration runner; preserve all document history.'
 WHERE to_regprocedure('public.openbooks_refresh_query_catalog()') IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
