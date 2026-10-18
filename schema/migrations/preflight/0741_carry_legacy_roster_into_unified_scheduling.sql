WITH template_slots AS (
 SELECT t.org_id, t.id, t.code, slot
 FROM public.hrm_shift_templates t CROSS JOIN LATERAL jsonb_array_elements(t.pattern->'slots') AS slots(slot)
), carried_codes AS (
 SELECT t.org_id, t.subsidiary_id, t.id,
  CASE WHEN count(*) OVER (PARTITION BY t.org_id, t.subsidiary_id, t.code) > 1
   THEN left(t.code, 64 - length('.' || t.version::text)) || '.' || t.version::text ELSE t.code END AS code
 FROM public.hrm_shift_templates t
), policy_uses AS (
 SELECT org_id, subsidiary_id, attendance_policy AS policy, starts_on AS on_date FROM public.hrm_shifts WHERE attendance_policy IS NOT NULL
 UNION ALL
 SELECT org_id, subsidiary_id, attendance_policy, effective_from FROM public.hrm_shift_templates WHERE attendance_policy IS NOT NULL
), policy_versions AS (
 SELECT org_id, subsidiary_id, policy, min(on_date) AS first_used, max(on_date) AS last_used FROM policy_uses GROUP BY org_id, subsidiary_id, policy
), policy_order AS (
 SELECT org_id, subsidiary_id, first_used, last_used,
  lead(first_used) OVER (PARTITION BY org_id, subsidiary_id ORDER BY first_used, last_used) AS next_first
 FROM policy_versions
), roster_subsidiaries AS (
 SELECT org_id, subsidiary_id FROM public.hrm_shift_assignments
 UNION SELECT org_id, subsidiary_id FROM public.hrm_shifts
 UNION SELECT org_id, subsidiary_id FROM public.hrm_shift_templates WHERE attendance_policy IS NOT NULL
), counts AS (
 SELECT '0741.shift_templates_carried'::text AS code, 'hrm_shift_templates'::text AS source, 'shift patterns'::text AS target, count(*) AS n,
  count(*) FILTER (WHERE status <> 'approved') AS inactive FROM public.hrm_shift_templates
 UNION ALL SELECT '0741.shift_assignments_carried', 'hrm_shift_assignments', 'shift pattern assignments', count(*), count(*) FILTER (WHERE status = 'draft') FROM public.hrm_shift_assignments
 UNION ALL SELECT '0741.shifts_carried', 'hrm_shifts', 'governed shift roster bookings', count(*), count(*) FILTER (WHERE status = 'closed') FROM public.hrm_shifts
 UNION ALL SELECT '0741.shift_requests_carried', 'hrm_shift_requests', 'shift requests', count(*), 0 FROM public.hrm_shift_requests
 UNION ALL SELECT '0741.attendance_devices_carried', 'hrm_attendance_devices', 'attendance devices', count(*), count(*) FILTER (WHERE NOT is_active) FROM public.hrm_attendance_devices
 UNION ALL SELECT '0741.attendance_identities_carried', 'hrm_attendance_identities', 'attendance device identities', count(*), 0 FROM public.hrm_attendance_identities
 UNION ALL SELECT '0741.attendance_batches_carried', 'hrm_attendance_batches', 'check-in batches', count(*), 0 FROM public.hrm_attendance_batches
 UNION ALL SELECT '0741.attendance_events_carried', 'hrm_attendance_events', 'check-ins', count(*), 0 FROM public.hrm_attendance_events
 UNION ALL SELECT '0741.attendance_observations_carried', 'hrm_attendance_observations', 'attendance observations', count(*), 0 FROM public.hrm_attendance_observations
), findings AS (
 SELECT '0741.unified_scheduling_missing'::text AS code, 'refuse'::text AS severity,
  'The shift roster tables this migration carries rows into are unavailable'::text AS subject,
  'The migration moves the earlier roster and attendance rows into the scheduling pattern, request and attendance tables created by 0737.'::text AS detail,
  'Install 0737_unified_scheduling_patterns_requests_attendance through the authorized native migration runner first; the earlier rows are unchanged.'::text AS remedy
 WHERE to_regclass('public.schedule_patterns') IS NULL OR to_regclass('public.schedule_entry_requests') IS NULL OR to_regclass('public.schedule_attendance_observations') IS NULL
 UNION ALL
 SELECT '0741.template_clock_precision', 'refuse', 'Shift template ' || ts.code,
  'A recurring slot uses clock times with seconds or a break that is not whole minutes up to 240; shift patterns keep minute clock times and breaks.',
  'Contact OpenBooks support to review the template before upgrading; the template and its history are unchanged.'
 FROM template_slots ts
 WHERE right(ts.slot->>'starts', 2) <> '00' OR right(ts.slot->>'ends', 2) <> '00'
  OR (ts.slot->>'plannedBreakSeconds')::integer % 60 <> 0 OR (ts.slot->>'plannedBreakSeconds')::integer > 14400
 UNION ALL
 SELECT '0741.template_cycle_missing', 'refuse', 'Shift template ' || t.code,
  'The template has no repeating cycle length and first date; a shift pattern needs both.',
  'Contact OpenBooks support to review the template before upgrading; the template and its history are unchanged.'
 FROM public.hrm_shift_templates t
 WHERE coalesce(t.pattern#>>'{schedule,cycleDays}', '') !~ '^[0-9]{1,3}$' OR coalesce(t.pattern#>>'{schedule,cycleAnchor}', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 UNION ALL
 SELECT '0741.pattern_code_taken', 'refuse', 'Shift pattern code ' || c.code,
  'A shift pattern with this code already exists for the template''s legal entity.',
  'Contact OpenBooks support to reconcile the two patterns before upgrading; both patterns and the template are unchanged.'
 FROM carried_codes c
 WHERE to_regclass('public.schedule_patterns') IS NOT NULL AND EXISTS (SELECT 1 FROM public.schedule_patterns p WHERE p.org_id = c.org_id
  AND coalesce(p.subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid) = c.subsidiary_id AND p.code = c.code AND p.id <> c.id)
 UNION ALL
 SELECT '0741.shift_break_precision', 'refuse', 'Shift ' || h.id::text,
  'The shift''s planned break is not a whole number of minutes up to 240, which bookings require.',
  'Contact OpenBooks support to review the shift before upgrading; the shift and its history are unchanged.'
 FROM public.hrm_shifts h WHERE h.planned_break_seconds % 60 <> 0 OR h.planned_break_seconds > 14400
 UNION ALL
 SELECT '0741.shift_name_length', 'refuse', 'Shift ' || h.id::text,
  'The shift name is longer than the 120 characters a booking detail holds.',
  'Contact OpenBooks support to review the shift before upgrading; the shift and its history are unchanged.'
 FROM public.hrm_shifts h WHERE length(btrim(h.name)) > 120
 UNION ALL
 SELECT '0741.attendance_policy_precision', 'refuse', 'Attendance bounds of legal entity ' || v.subsidiary_id::text,
  'A capture or grace bound is not a whole number of minutes; board attendance policies keep minutes.',
  'Contact OpenBooks support to review the attendance bounds before upgrading; the roster history is unchanged.'
 FROM policy_versions v
 WHERE (v.policy->>'captureBeforeSeconds')::integer % 60 <> 0 OR (v.policy->>'captureAfterSeconds')::integer % 60 <> 0
  OR (v.policy->>'lateGraceSeconds')::integer % 60 <> 0 OR (v.policy->>'earlyGraceSeconds')::integer % 60 <> 0
 UNION ALL
 SELECT '0741.attendance_policy_interleaved', 'refuse', 'Attendance bounds of legal entity ' || o.subsidiary_id::text,
  'Different capture and grace bounds were in use over overlapping dates; one board policy version applies on each date.',
  'Contact OpenBooks support to review the overlapping attendance bounds before upgrading; the roster history is unchanged.'
 FROM policy_order o WHERE o.next_first IS NOT NULL AND o.last_used >= o.next_first
 UNION ALL
 SELECT '0741.shift_overlaps_booking', 'refuse', 'Shift ' || h.id::text,
  'A published roster shift overlaps a published booking of the same person on a scheduling board; a person is booked at most once at any instant.',
  'Remove or move the overlapping booking on its scheduling board, then upgrade; the roster shift is carried unchanged.'
 FROM public.hrm_shifts h
 WHERE h.status IN ('published','closed') AND EXISTS (SELECT 1 FROM public.schedule_entries e WHERE e.org_id = h.org_id AND e.worker_party_id = h.worker_party_id
  AND e.status = 'published' AND e.id <> h.id AND tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange(h.starts_at, h.ends_at, '[)'))
 UNION ALL
 SELECT '0741.device_code_taken', 'refuse', 'Attendance device ' || d.code,
  'An attendance device with this code already exists in Unified Scheduling.',
  'Contact OpenBooks support to reconcile the two devices before upgrading; both devices and their check-ins are unchanged.'
 FROM public.hrm_attendance_devices d
 WHERE to_regclass('public.schedule_attendance_devices') IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.schedule_attendance_devices x WHERE x.org_id = d.org_id AND x.code = d.code AND x.id <> d.id)
 UNION ALL
 SELECT '0741.roster_board_code_taken', 'refuse', 'Board code ROSTER-' || upper(substr(md5(r.subsidiary_id::text), 1, 8)),
  'The shift roster board carried for this legal entity needs a code another board already uses.',
  'Contact OpenBooks support to reconcile the board codes before upgrading; the boards and the roster history are unchanged.'
 FROM roster_subsidiaries r
 WHERE EXISTS (SELECT 1 FROM public.schedule_boards b WHERE b.org_id = r.org_id AND b.code = 'ROSTER-' || upper(substr(md5(r.subsidiary_id::text), 1, 8))
  AND b.id <> md5('openbooks-shift-roster:' || r.org_id::text || ':' || r.subsidiary_id::text)::uuid)
 UNION ALL
 SELECT '0741.carried_rows_exist', 'refuse', 'Rows with carried identities already exist',
  'Scheduling rows already use the identities of earlier roster rows, so the carry-over would duplicate or overwrite them.',
  'Preserve both sets of rows; compare them with the reviewed migration and obtain the database owner''s approval before reconciliation.'
 WHERE to_regclass('public.schedule_patterns') IS NOT NULL AND (
  EXISTS (SELECT 1 FROM public.schedule_patterns p JOIN public.hrm_shift_templates t ON t.id = p.id)
  OR EXISTS (SELECT 1 FROM public.schedule_entries e JOIN public.hrm_shifts h ON h.id = e.id)
  OR EXISTS (SELECT 1 FROM public.schedule_attendance_devices x JOIN public.hrm_attendance_devices d ON d.id = x.id))
 UNION ALL
 SELECT c.code, 'notice', c.n::text || ' row(s) of ' || c.source,
  'Carried as ' || c.target || CASE
   WHEN c.source = 'hrm_shift_templates' AND c.inactive > 0 THEN '; ' || c.inactive::text || ' not approved become inactive patterns'
   WHEN c.source = 'hrm_shift_assignments' AND c.inactive > 0 THEN '; ' || c.inactive::text || ' draft assignments are carried cancelled'
   WHEN c.source = 'hrm_shifts' AND c.inactive > 0 THEN '; ' || c.inactive::text || ' closed shifts keep their closing evidence'
   WHEN c.source = 'hrm_attendance_devices' AND c.inactive > 0 THEN '; ' || c.inactive::text || ' inactive devices stay inactive'
   ELSE '' END || '.',
  'No action is needed; the rows keep their identities, actors, dates and reasons.'
 FROM counts c WHERE c.n > 0
 UNION ALL
 SELECT '0741.roster_board_created', 'notice', 'Legal entity ' || r.subsidiary_id::text,
  'A governed shift roster board ROSTER-' || upper(substr(md5(r.subsidiary_id::text), 1, 8)) || ' is created to hold the legal entity''s roster history.',
  'Review the board''s settings in Scheduling after the upgrade.'
 FROM roster_subsidiaries r
)
SELECT code, severity, subject, detail, remedy FROM findings;
