WITH findings AS (
 SELECT '0746.publications_exist'::text AS code,
  'Schedule publications exist without this migration being recorded'::text AS subject,
  'The migration creates schedule_publications and adds released_without_approval to schedule_entry_requests.'::text AS detail,
  'Preserve the objects and every row; compare them with the reviewed migration and obtain the database owner''s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.schedule_publications') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.schedule_entry_requests') AND attname = 'released_without_approval' AND NOT attisdropped)
 UNION ALL
 SELECT '0746.shift_roster_missing', 'The shift roster tables this migration extends are unavailable',
  'The migration revises the booking and roster guards created by 0737.',
  'Install 0737_unified_scheduling_patterns_requests_attendance through the authorized native migration runner first.'
 WHERE to_regclass('public.schedule_entry_requests') IS NULL OR to_regprocedure('public.schedule_roster_guard()') IS NULL
  OR to_regprocedure('public.schedule_assert_independent(uuid,uuid,uuid[],uuid[])') IS NULL
)
SELECT code, 'refuse'::text AS severity, subject, detail, remedy FROM findings;
