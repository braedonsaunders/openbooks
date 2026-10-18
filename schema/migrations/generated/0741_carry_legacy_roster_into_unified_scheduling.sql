-- Carry the earlier roster and attendance records into Unified Scheduling,
-- then retire their tables.
--
-- Every row moves with its identity, actors, timestamps, revision and
-- reason:
--  - recurring shift templates become shift patterns (approved templates are
--    active; drafts, retired and cancelled templates are inactive);
--  - each legal entity with assignments, shifts or template attendance bounds
--    gains one governed shift roster board, governed from its earliest
--    roster date, with one attendance policy version per distinct legacy
--    capture and grace policy effective from its first use;
--  - assignments, their publication omissions and selected instants, shifts
--    (closed shifts keep their closing evidence), shift requests, devices,
--    device identities, check-in batches, events, watermarks, observations,
--    event claims and observation evidence move to their scheduling
--    counterparts; draft assignments, never in force, are carried cancelled.
-- The booking, roster and attendance guards are suspended only while the
-- carried history is inserted, because they admit new commands rather than
-- recorded history; constraints and exclusion rules stay in force. The
-- preflight refuses any row that cannot move without changing its meaning.
--
-- The booking ledger stops consulting the retired roster when it checks a
-- person's availability.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.schedule_entries DISABLE TRIGGER schedule_entries_guard;
ALTER TABLE public.schedule_patterns DISABLE TRIGGER schedule_roster_guard;
ALTER TABLE public.schedule_pattern_assignments DISABLE TRIGGER schedule_roster_guard;
ALTER TABLE public.schedule_pattern_exceptions DISABLE TRIGGER schedule_roster_guard;
ALTER TABLE public.schedule_entry_requests DISABLE TRIGGER schedule_roster_guard;
ALTER TABLE public.schedule_entry_requests DISABLE TRIGGER schedule_entry_requests_outcome_guard;
ALTER TABLE public.schedule_attendance_devices DISABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_identities DISABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_policies DISABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_batches DISABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_batches DISABLE TRIGGER schedule_attendance_evidence_guard;
ALTER TABLE public.schedule_attendance_events DISABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_events DISABLE TRIGGER schedule_attendance_evidence_guard;
ALTER TABLE public.schedule_attendance_watermarks DISABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_observations DISABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_observations DISABLE TRIGGER schedule_attendance_evidence_guard;
ALTER TABLE public.schedule_attendance_event_claims DISABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_observation_events DISABLE TRIGGER schedule_attendance_guard;

-- Recurring templates become shift patterns. A code used by several
-- versions of the same legal entity is qualified by its version.
INSERT INTO public.schedule_patterns (id, org_id, subsidiary_id, code, name, description, time_zone, cycle_days, cycle_anchor, slots,
 horizon_days, is_active, reason, revision, created_at, created_by, updated_at, updated_by)
SELECT t.id, t.org_id, t.subsidiary_id,
 CASE WHEN count(*) OVER (PARTITION BY t.org_id, t.subsidiary_id, t.code) > 1
  THEN left(t.code, 64 - length('.' || t.version::text)) || '.' || t.version::text ELSE t.code END,
 btrim(t.name), t.description, t.pattern->>'timeZone', (t.pattern#>>'{schedule,cycleDays}')::smallint, (t.pattern#>>'{schedule,cycleAnchor}')::date,
 (SELECT jsonb_agg(jsonb_build_object('position', (slot->>'position')::integer, 'starts', left(slot->>'starts', 5), 'ends', left(slot->>'ends', 5),
    'breakMinutes', (slot->>'plannedBreakSeconds')::integer / 60, 'qualificationTypeIds', slot->'qualificationTypeIds') ORDER BY ordinal)
  FROM jsonb_array_elements(t.pattern->'slots') WITH ORDINALITY AS slots(slot, ordinal)),
 28, t.status = 'approved', t.reason, t.revision, t.created_at, t.created_by, t.updated_at, t.updated_by
FROM public.hrm_shift_templates t
ORDER BY t.org_id, t.id;

-- One governed shift roster board per legal entity that holds roster history.
WITH needs AS (
 SELECT org_id, subsidiary_id FROM public.hrm_shift_assignments
 UNION SELECT org_id, subsidiary_id FROM public.hrm_shifts
 UNION SELECT org_id, subsidiary_id FROM public.hrm_shift_templates WHERE attendance_policy IS NOT NULL
)
INSERT INTO public.schedule_boards (id, org_id, code, name, description, row_kind, board_type, subsidiary_id, grain, views, default_view,
 time_zone, publish_policy, governed_from)
SELECT md5('openbooks-shift-roster:' || n.org_id::text || ':' || n.subsidiary_id::text)::uuid, n.org_id,
 'ROSTER-' || upper(substr(md5(n.subsidiary_id::text), 1, 8)),
 btrim(left('Shift roster — ' || btrim(s.name), 120)),
 'Shift roster carried from the legal entity''s earlier roster and attendance records.',
 'people', 'shift_roster', n.subsidiary_id, 'timed', ARRAY['timeline','grid','calendar']::text[], 'timeline',
 coalesce(
  (SELECT h.time_zone FROM public.hrm_shifts h WHERE h.org_id = n.org_id AND h.subsidiary_id = n.subsidiary_id GROUP BY h.time_zone ORDER BY count(*) DESC, h.time_zone LIMIT 1),
  (SELECT t.pattern->>'timeZone' FROM public.hrm_shift_templates t WHERE t.org_id = n.org_id AND t.subsidiary_id = n.subsidiary_id ORDER BY t.created_at, t.id LIMIT 1),
  'UTC'),
 'governed',
 coalesce(least(
  (SELECT min(h.starts_on) FROM public.hrm_shifts h WHERE h.org_id = n.org_id AND h.subsidiary_id = n.subsidiary_id),
  (SELECT min(a.effective_from) FROM public.hrm_shift_assignments a WHERE a.org_id = n.org_id AND a.subsidiary_id = n.subsidiary_id),
  (SELECT min(t.effective_from) FROM public.hrm_shift_templates t WHERE t.org_id = n.org_id AND t.subsidiary_id = n.subsidiary_id AND t.attendance_policy IS NOT NULL)),
  current_date)
FROM needs n JOIN public.subsidiaries s ON s.org_id = n.org_id AND s.id = n.subsidiary_id
ORDER BY n.org_id, n.subsidiary_id;

-- One attendance policy version per distinct legacy policy, from its first use.
WITH uses AS (
 SELECT org_id, subsidiary_id, attendance_policy AS policy, starts_on AS on_date, created_at, created_by FROM public.hrm_shifts WHERE attendance_policy IS NOT NULL
 UNION ALL
 SELECT org_id, subsidiary_id, attendance_policy, effective_from, created_at, created_by FROM public.hrm_shift_templates WHERE attendance_policy IS NOT NULL
), versions AS (
 SELECT org_id, subsidiary_id, policy, min(on_date) AS effective_from,
  (array_agg(created_by ORDER BY on_date, created_at, created_by))[1] AS created_by,
  (array_agg(created_at ORDER BY on_date, created_at, created_by))[1] AS created_at
 FROM uses GROUP BY org_id, subsidiary_id, policy
)
INSERT INTO public.schedule_attendance_policies (id, org_id, board_id, effective_from, capture_before_minutes, capture_after_minutes,
 late_grace_minutes, early_grace_minutes, break_grace_minutes, reason, created_at, created_by)
SELECT md5('openbooks-shift-roster-policy:' || v.org_id::text || ':' || v.subsidiary_id::text || ':' || v.effective_from::text)::uuid, v.org_id,
 md5('openbooks-shift-roster:' || v.org_id::text || ':' || v.subsidiary_id::text)::uuid, v.effective_from,
 (v.policy->>'captureBeforeSeconds')::integer / 60, (v.policy->>'captureAfterSeconds')::integer / 60,
 (v.policy->>'lateGraceSeconds')::integer / 60, (v.policy->>'earlyGraceSeconds')::integer / 60, 0,
 'Attendance capture and grace bounds carried from the earlier roster.', v.created_at, v.created_by
FROM versions v
ORDER BY v.org_id, v.subsidiary_id, v.effective_from;

-- Assignments keep their windows; drafts, never in force, are carried cancelled.
INSERT INTO public.schedule_pattern_assignments (id, org_id, board_id, pattern_id, worker_party_id, employment_id, subsidiary_id,
 effective_from, effective_to, status, generated_through, reason, request_hash, revision, created_at, created_by, updated_at, updated_by)
SELECT a.id, a.org_id, md5('openbooks-shift-roster:' || a.org_id::text || ':' || a.subsidiary_id::text)::uuid, a.template_id,
 a.worker_party_id, a.employment_id, a.subsidiary_id, a.effective_from, a.effective_to,
 CASE a.status WHEN 'approved' THEN 'active' WHEN 'ended' THEN 'ended' ELSE 'cancelled' END,
 (SELECT max(p.through_on) FROM public.hrm_shift_publications p WHERE p.org_id = a.org_id AND p.assignment_id = a.id),
 a.reason, a.request_hash, a.revision, a.created_at, a.created_by, a.updated_at, a.updated_by
FROM public.hrm_shift_assignments a
ORDER BY a.org_id, a.id;

-- Publication decisions become occurrence exceptions of their assignment.
INSERT INTO public.schedule_pattern_exceptions (id, org_id, assignment_id, occurs_on, slot_index, kind, starts_at, ends_at, reason, created_at, created_by)
SELECT md5('openbooks-shift-roster-exception:' || p.id::text || ':' || choice.key)::uuid, p.org_id, p.assignment_id,
 split_part(choice.key, ':', 1)::date, split_part(choice.key, ':', 2)::smallint,
 CASE WHEN choice.value ? 'omitReason' THEN 'omit' ELSE 'select_instant' END,
 CASE WHEN choice.value ? 'omitReason' THEN NULL ELSE (choice.value->>'startsAt')::timestamptz END,
 CASE WHEN choice.value ? 'omitReason' THEN NULL ELSE (choice.value->>'endsAt')::timestamptz END,
 coalesce(nullif(btrim(choice.value->>'omitReason'), ''), p.reason), p.created_at, p.created_by
FROM public.hrm_shift_publications p
CROSS JOIN LATERAL jsonb_each(p.occurrence_selections) AS choice(key, value)
WHERE choice.value ? 'omitReason' OR (choice.value ? 'startsAt' AND choice.value ? 'endsAt')
ORDER BY p.org_id, p.id, choice.key;

-- Shifts keep their identity as governed bookings of the roster board; a
-- replacement follows the shift it replaces.
WITH RECURSIVE chain(id, depth) AS (
 SELECT id, 0 FROM public.hrm_shifts WHERE supersedes_id IS NULL
 UNION ALL
 SELECT h.id, chain.depth + 1 FROM public.hrm_shifts h JOIN chain ON h.supersedes_id = chain.id
)
INSERT INTO public.schedule_entries (id, org_id, board_id, worker_party_id, employment_id, subsidiary_id, detail, span_mode, time_zone,
 starts_on, ends_on, starts_at, ends_at, break_minutes, supersedes_id, status, published_by, published_at, reason, request_hash,
 created_at, created_by, updated_at, updated_by, revision, governed, pattern_assignment_id, pattern_occurs_on, pattern_slot,
 origin_request_id, required_qualification_type_ids, closed_at, closed_by, close_reason)
SELECT h.id, h.org_id, md5('openbooks-shift-roster:' || h.org_id::text || ':' || h.subsidiary_id::text)::uuid, h.worker_party_id, h.employment_id,
 h.subsidiary_id, btrim(h.name), 'timed', h.time_zone, h.starts_on, h.ends_on, h.starts_at, h.ends_at, h.planned_break_seconds / 60, h.supersedes_id,
 CASE h.status WHEN 'closed' THEN 'published' ELSE h.status END, h.decided_by, h.decided_at, h.reason, h.request_hash,
 h.created_at, h.created_by, h.updated_at, h.updated_by, h.revision, true,
 p.assignment_id, CASE WHEN p.id IS NOT NULL THEN h.starts_on END, CASE WHEN p.id IS NOT NULL THEN h.slot_index::smallint END,
 h.origin_request_id, ARRAY(SELECT jsonb_array_elements_text(h.qualification_type_ids))::uuid[],
 CASE WHEN h.status = 'closed' THEN h.updated_at END, CASE WHEN h.status = 'closed' THEN h.updated_by END, CASE WHEN h.status = 'closed' THEN h.reason END
FROM public.hrm_shifts h
LEFT JOIN public.hrm_shift_publications p ON p.org_id = h.org_id AND p.id = h.publication_id
JOIN chain ON chain.id = h.id
ORDER BY chain.depth, h.org_id, h.starts_at, h.id;

-- Shift requests keep their decisions; the request's own reason is the one
-- it was created with.
INSERT INTO public.schedule_entry_requests (id, org_id, board_id, entry_id, entry_revision, worker_party_id, subsidiary_id, kind,
 proposed_starts_at, proposed_ends_at, proposed_break_minutes, status, decided_by, decided_at, decision_reason, reason, request_hash,
 revision, created_at, created_by, updated_at, updated_by)
SELECT r.id, r.org_id, md5('openbooks-shift-roster:' || r.org_id::text || ':' || r.subsidiary_id::text)::uuid, r.shift_id, r.shift_revision,
 r.worker_party_id, r.subsidiary_id, r.kind, r.proposed_starts_at, r.proposed_ends_at,
 CASE WHEN r.kind = 'change' THEN h.planned_break_seconds / 60 END,
 r.status, r.decided_by, r.decided_at, CASE WHEN r.status IN ('approved','declined') THEN r.reason END,
 coalesce((SELECT a.changes->'after'->>'reason' FROM public.audit_log a WHERE a.org_id = r.org_id AND a.table_name = 'hrm_shift_requests'
   AND a.row_id = r.id AND a.action = 'insert' ORDER BY a.id LIMIT 1), r.reason),
 r.request_hash, r.revision, r.created_at, r.created_by, r.updated_at, r.updated_by
FROM public.hrm_shift_requests r
JOIN public.hrm_shifts h ON h.org_id = r.org_id AND h.id = r.shift_id
ORDER BY r.org_id, r.id;

INSERT INTO public.schedule_attendance_devices (id, org_id, subsidiary_id, code, name, time_zone, is_active, reason, request_hash, revision,
 created_at, created_by, updated_at, updated_by)
SELECT d.id, d.org_id, d.subsidiary_id, d.code, btrim(d.name), d.time_zone, d.is_active, d.reason, d.request_hash, d.revision,
 d.created_at, d.created_by, d.updated_at, d.updated_by
FROM public.hrm_attendance_devices d
ORDER BY d.org_id, d.id;

INSERT INTO public.schedule_attendance_identities (id, org_id, device_id, source_worker_id, subsidiary_id, worker_party_id, employment_id,
 effective_from, effective_to, reason, request_hash, revision, created_at, created_by, updated_at, updated_by)
SELECT i.id, i.org_id, i.device_id, btrim(i.source_worker_id), i.subsidiary_id, i.worker_party_id, i.employment_id,
 i.effective_from, i.effective_to, i.reason, i.request_hash, i.revision, i.created_at, i.created_by, i.updated_at, i.updated_by
FROM public.hrm_attendance_identities i
ORDER BY i.org_id, i.id;

INSERT INTO public.schedule_attendance_batches (id, org_id, device_id, complete_through, is_correction, source_evidence, event_count,
 reason, request_hash, created_at, created_by)
SELECT b.id, b.org_id, b.device_id, b.complete_through, coalesce(b.source_evidence->'correction' = 'true'::jsonb, false), b.source_evidence,
 b.event_count, b.reason, b.request_hash, b.created_at, b.created_by
FROM public.hrm_attendance_batches b
ORDER BY b.org_id, b.id;

INSERT INTO public.schedule_attendance_events (id, org_id, device_id, batch_id, identity_id, subsidiary_id, worker_party_id, employment_id,
 source_event_id, source_version, kind, occurred_at, source_local_date, source_payload, supersedes_id, reason, request_hash, created_at, created_by)
SELECT e.id, e.org_id, e.device_id, e.batch_id, e.identity_id, e.subsidiary_id, e.worker_party_id, e.employment_id,
 e.source_event_id, e.source_version, e.kind, e.occurred_at, e.source_local_date, e.source_payload, e.supersedes_id, e.reason, e.request_hash,
 e.created_at, e.created_by
FROM public.hrm_attendance_events e
ORDER BY e.org_id, e.source_version, e.occurred_at, e.id;

INSERT INTO public.schedule_attendance_watermarks (id, org_id, device_id, batch_id, complete_through, reason, revision, created_at, created_by, updated_at, updated_by)
SELECT w.id, w.org_id, w.device_id, w.batch_id, w.complete_through, w.reason, w.revision, w.created_at, w.created_by, w.updated_at, w.updated_by
FROM public.hrm_attendance_watermarks w
ORDER BY w.org_id, w.id;

-- Observations name the carried policy version effective on the shift date;
-- a present observation records whether breaks exceeded the planned break.
INSERT INTO public.schedule_attendance_observations (id, org_id, entry_id, board_id, policy_id, subsidiary_id, worker_party_id, employment_id,
 status, complete_through, first_in, last_out, presence_milliseconds, break_milliseconds, late, left_early, over_break,
 source_evidence, evidence_hash, supersedes_id, reason, request_hash, created_at, created_by)
SELECT o.id, o.org_id, o.shift_id, md5('openbooks-shift-roster:' || o.org_id::text || ':' || o.subsidiary_id::text)::uuid,
 CASE WHEN o.status = 'voided' THEN NULL ELSE (SELECT pv.id FROM public.schedule_attendance_policies pv
   WHERE pv.org_id = o.org_id AND pv.board_id = md5('openbooks-shift-roster:' || o.org_id::text || ':' || o.subsidiary_id::text)::uuid
     AND pv.effective_from <= h.starts_on ORDER BY pv.effective_from DESC LIMIT 1) END,
 o.subsidiary_id, o.worker_party_id, o.employment_id, o.status, o.complete_through, o.first_in, o.last_out,
 o.presence_milliseconds, o.break_milliseconds, o.late, o.left_early,
 CASE o.status WHEN 'present' THEN o.break_milliseconds > h.planned_break_seconds::bigint * 1000 WHEN 'absent' THEN false END,
 o.source_evidence, o.evidence_hash, o.supersedes_id, o.reason, o.request_hash, o.created_at, o.created_by
FROM public.hrm_attendance_observations o
JOIN public.hrm_shifts h ON h.org_id = o.org_id AND h.id = o.shift_id
ORDER BY o.org_id, o.shift_id, o.created_at, o.id;

INSERT INTO public.schedule_attendance_event_claims (id, org_id, event_id, entry_id, released_at, released_by, release_reason, reason, request_hash, created_at, created_by)
SELECT c.id, c.org_id, c.event_id, c.shift_id, c.released_at, c.released_by, c.release_reason, c.reason, c.request_hash, c.created_at, c.created_by
FROM public.hrm_attendance_event_claims c
ORDER BY c.org_id, c.id;

INSERT INTO public.schedule_attendance_observation_events (id, org_id, observation_id, event_claim_id, reason, request_hash, created_at, created_by)
SELECT oe.id, oe.org_id, oe.observation_id, oe.event_claim_id, oe.reason, oe.request_hash, oe.created_at, oe.created_by
FROM public.hrm_attendance_observation_events oe
ORDER BY oe.org_id, oe.id;

-- Deferred reference checks of the carried rows run now, before the guards
-- are restored.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE public.schedule_entries ENABLE TRIGGER schedule_entries_guard;
ALTER TABLE public.schedule_patterns ENABLE TRIGGER schedule_roster_guard;
ALTER TABLE public.schedule_pattern_assignments ENABLE TRIGGER schedule_roster_guard;
ALTER TABLE public.schedule_pattern_exceptions ENABLE TRIGGER schedule_roster_guard;
ALTER TABLE public.schedule_entry_requests ENABLE TRIGGER schedule_roster_guard;
ALTER TABLE public.schedule_entry_requests ENABLE TRIGGER schedule_entry_requests_outcome_guard;
ALTER TABLE public.schedule_attendance_devices ENABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_identities ENABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_policies ENABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_batches ENABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_batches ENABLE TRIGGER schedule_attendance_evidence_guard;
ALTER TABLE public.schedule_attendance_events ENABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_events ENABLE TRIGGER schedule_attendance_evidence_guard;
ALTER TABLE public.schedule_attendance_watermarks ENABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_observations ENABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_observations ENABLE TRIGGER schedule_attendance_evidence_guard;
ALTER TABLE public.schedule_attendance_event_claims ENABLE TRIGGER schedule_attendance_guard;
ALTER TABLE public.schedule_attendance_observation_events ENABLE TRIGGER schedule_attendance_guard;

-- Every carried row is verified before the earlier tables are retired.
DO $verify$
DECLARE pair record; carried bigint; expected bigint;
BEGIN
 FOR pair IN SELECT * FROM (VALUES
  ('hrm_shift_templates', 'schedule_patterns'),
  ('hrm_shift_assignments', 'schedule_pattern_assignments'),
  ('hrm_shifts', 'schedule_entries'),
  ('hrm_shift_requests', 'schedule_entry_requests'),
  ('hrm_attendance_devices', 'schedule_attendance_devices'),
  ('hrm_attendance_identities', 'schedule_attendance_identities'),
  ('hrm_attendance_batches', 'schedule_attendance_batches'),
  ('hrm_attendance_events', 'schedule_attendance_events'),
  ('hrm_attendance_watermarks', 'schedule_attendance_watermarks'),
  ('hrm_attendance_observations', 'schedule_attendance_observations'),
  ('hrm_attendance_event_claims', 'schedule_attendance_event_claims'),
  ('hrm_attendance_observation_events', 'schedule_attendance_observation_events')
 ) AS mapping(source, target) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I', pair.source) INTO expected;
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE EXISTS (SELECT 1 FROM public.%I s WHERE s.org_id = t.org_id AND s.id = t.id)', pair.target, pair.source) INTO carried;
  IF carried <> expected THEN
   RAISE EXCEPTION 'Carrying % into % moved % of % rows; nothing was changed.', pair.source, pair.target, carried, expected;
  END IF;
 END LOOP;
END $verify$;

-- The earlier tables reference one another, so they leave together.
DROP TABLE public.hrm_attendance_observation_events, public.hrm_attendance_event_claims, public.hrm_attendance_observations,
 public.hrm_attendance_watermarks, public.hrm_attendance_events, public.hrm_attendance_batches, public.hrm_attendance_identities,
 public.hrm_attendance_devices, public.hrm_shift_requests, public.hrm_shifts, public.hrm_shift_publications,
 public.hrm_shift_assignments, public.hrm_shift_templates;
DROP FUNCTION public.hrm_shift_guard();
DROP FUNCTION public.hrm_shift_evidence_guard();
DROP FUNCTION public.hrm_shift_audit();
DROP FUNCTION public.hrm_shift_assert_attendance_current(uuid, uuid);
DROP FUNCTION public.hrm_shift_assert_available(uuid, uuid, uuid, uuid, date, date, jsonb);
DROP FUNCTION public.hrm_shift_assert_employment(uuid, uuid, uuid, uuid, date, date);
DROP FUNCTION public.hrm_shift_assert_independent(uuid, uuid, uuid, uuid, uuid);
DROP FUNCTION public.hrm_shift_validate_pattern(uuid, uuid, jsonb);
DROP FUNCTION public.hrm_shift_validate_requirements(uuid, jsonb);
DROP FUNCTION public.hrm_shift_attendance_policy(jsonb);
DROP INDEX public.hrm_shift_work_schedule_subject;
DROP INDEX public.hrm_shift_employment_subject;

-- Publication refuses recorded leave the booking would overlap.
CREATE OR REPLACE FUNCTION public.schedule_entry_assert_available(entry public.schedule_entries) RETURNS void
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE blocked date; last_date date;
BEGIN
 last_date := ((entry.ends_at - interval '1 millisecond') AT TIME ZONE entry.time_zone)::date;
 SELECT a.on_date INTO blocked FROM public.hrm_absences a
  JOIN public.worker_employments e ON e.org_id = a.org_id AND e.id = a.employment_id
  WHERE a.org_id = entry.org_id AND e.worker_party_id = entry.worker_party_id AND a.on_date BETWEEN entry.starts_on AND last_date
  GROUP BY a.on_date, a.employment_id, a.leave_type_id HAVING sum(a.hours) <> 0 ORDER BY a.on_date LIMIT 1;
 IF FOUND THEN
  RAISE EXCEPTION 'Recorded leave covers %; choose another date or correct the leave through its request.', blocked USING ERRCODE = '23514';
 END IF;
END $function$;

SELECT public.openbooks_refresh_query_catalog();
