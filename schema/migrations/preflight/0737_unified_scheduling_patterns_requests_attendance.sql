WITH findings AS (
 SELECT '0737.scheduling_objects_exist'::text AS code,
  'Unified scheduling board-type, pattern, request or attendance objects exist without this migration being recorded'::text AS subject,
  'The migration creates the board-type registry and the schedule pattern, assignment, exception, request and attendance tables, adds board_type and governed_from to schedule_boards, and adds governance, pattern, request and closing columns to schedule_entries.'::text AS detail,
  'Preserve the objects and every row; compare them with the reviewed migration and obtain the database owner''s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.schedule_patterns') IS NOT NULL
  OR to_regclass('public.openbooks_schedule_board_types') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.schedule_boards') AND attname = 'board_type' AND NOT attisdropped)
  OR to_regclass('public.schedule_pattern_assignments') IS NOT NULL
  OR to_regclass('public.schedule_entry_requests') IS NOT NULL
  OR to_regclass('public.schedule_attendance_devices') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.schedule_entries') AND attname = 'governed' AND NOT attisdropped)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.schedule_boards') AND attname = 'governed_from' AND NOT attisdropped)
 UNION ALL
 SELECT '0737.scheduling_ledger_missing','The unified scheduling tables this migration extends are unavailable',
  'The migration extends schedule_boards and schedule_entries, created by the published scheduling migrations.',
  'Install the published migrations through the authorized native migration runner; preserve all booking history.'
 WHERE to_regclass('public.schedule_entries') IS NULL OR to_regclass('public.schedule_boards') IS NULL
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = to_regclass('public.schedule_boards') AND conname = 'schedule_boards_publish_policy_check')
  OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = to_regclass('public.schedule_entries') AND conname = 'schedule_entries_org_id_supersedes_id_key')
 UNION ALL
 SELECT '0737.retirement_fence_missing','The tenant retirement fence is unavailable',
  'Every new tenant table installs the native tenant retirement fence.',
  'Install the published tenant retirement migrations through the authorized native migration runner.'
 WHERE to_regprocedure('tenant_retirement.openbooks_tenant_retirement_fence()') IS NULL
  OR to_regprocedure('tenant_retirement.openbooks_tenant_retirement_delete_allowed(text,jsonb)') IS NULL
 UNION ALL
 SELECT '0737.qualification_ledger_missing','The qualification ledger is unavailable',
  'Pattern slots may require native qualification types verified on the person''s employment.',
  'Install the published qualification migrations through the authorized native migration runner.'
 WHERE to_regclass('public.hrm_qualification_types') IS NULL OR to_regclass('public.hrm_worker_qualifications') IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
