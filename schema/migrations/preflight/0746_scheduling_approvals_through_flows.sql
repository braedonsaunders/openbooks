-- The roster objects 0737 creates are referenced directly so the runner defers
-- this check while 0737 is pending in the same upgrade, and fails loudly when
-- they are genuinely absent.
WITH required_roster AS (
 SELECT (SELECT count(*) FROM (SELECT 1 FROM public.schedule_entry_requests LIMIT 0) requests) AS present,
  'public.schedule_roster_guard()'::regprocedure AS roster_guard
),
findings AS (
 SELECT '0746.publications_exist'::text AS code,
  'Schedule publications exist without this migration being recorded'::text AS subject,
  'The migration creates schedule_publications and adds released_without_approval to schedule_entry_requests.'::text AS detail,
  'Preserve the objects and every row; compare them with the reviewed migration and obtain the database owner''s approval before reconciliation.'::text AS remedy
 WHERE to_regclass('public.schedule_publications') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('public.schedule_entry_requests') AND attname = 'released_without_approval' AND NOT attisdropped)
)
SELECT code, 'refuse'::text AS severity, subject, detail, remedy FROM findings;
