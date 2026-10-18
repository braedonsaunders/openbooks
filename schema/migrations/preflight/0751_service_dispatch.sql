WITH findings AS (
 SELECT '0751.service_objects_exist'::text AS code,
  'Service dispatch objects exist without this migration being recorded'::text AS subject,
  'The migration creates the service request, job, visit, agreement, quote, billing and notice tables, the dispatch board type and the service visit columns on schedule entries and time entries.'::text AS detail,
  'Preserve the objects and every row; compare them with the reviewed migration and obtain the database owner''s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.service_visits') IS NOT NULL OR to_regclass('public.service_jobs') IS NOT NULL
  OR to_regclass('public.service_requests') IS NOT NULL OR to_regclass('public.service_dispatch_policies') IS NOT NULL
  OR to_regprocedure('public.service_dispatch_enabled(uuid)') IS NOT NULL
  OR to_regclass('public.addresses_org_id_id_unique') IS NOT NULL OR to_regclass('public.contacts_org_id_id_unique') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.schedule_entries') AND attname = 'service_visit_id' AND NOT attisdropped)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.time_entries') AND attname = 'service_visit_id' AND NOT attisdropped)
 UNION ALL
 SELECT '0751.dispatch_type_registered', 'A dispatch board type is already registered',
  'The migration registers the dispatch board type and its capabilities in the board-type registry.',
  'Compare the registered row with the reviewed migration and obtain the database owner''s approval before reconciliation.'
 WHERE to_regclass('public.openbooks_schedule_board_types') IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.openbooks_schedule_board_types WHERE key = 'dispatch')
 UNION ALL
 SELECT '0751.scheduling_missing', 'The unified scheduling objects this migration extends are unavailable',
  'The migration extends the board-type registry, the board type guard and the booking ledger.',
  'Install 0746_scheduling_approvals_through_flows through the authorized native migration runner first.'
 WHERE to_regclass('public.openbooks_schedule_board_types') IS NULL OR to_regclass('public.schedule_publications') IS NULL
  OR to_regprocedure('public.schedule_boards_type_guard()') IS NULL OR to_regprocedure('public.schedule_board_has_capability(uuid,uuid,text)') IS NULL
 UNION ALL
 SELECT '0751.time_cost_object_missing', 'The time entry cost-object constraint this migration replaces is unavailable',
  'The migration replaces time_entries_one_cost_object_check to admit a service visit as a third exclusive cost object.',
  'Compare time_entries constraints with the published migrations and obtain the database owner''s approval before reconciliation.'
 WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = to_regclass('public.time_entries') AND conname = 'time_entries_one_cost_object_check')
 UNION ALL
 SELECT '0751.duplicate_address_identity', 'Party addresses or contacts repeat an identity within an organization',
  'The migration adds unique (org_id, id) indexes on addresses and contacts for tenant foreign keys.',
  'Preserve the rows and report the duplicates to the database owner before reconciliation.'
 WHERE EXISTS (SELECT 1 FROM public.addresses GROUP BY org_id, id HAVING count(*) > 1)
  OR EXISTS (SELECT 1 FROM public.contacts GROUP BY org_id, id HAVING count(*) > 1)
)
SELECT code, 'refuse'::text AS severity, subject, detail, remedy FROM findings;
