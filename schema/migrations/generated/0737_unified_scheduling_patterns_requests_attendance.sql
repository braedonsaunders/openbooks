-- Unified Scheduling: board types, and the shift roster board type with
-- recurring shift patterns, employee shift requests, governed publication,
-- device attendance and formal shift closing.
--
-- Board types are a registry. Each type names its row kind and the
-- capabilities its boards enable; every existing board keeps the type of its
-- row kind (people, tasks, resources) and behaves exactly as before. Shift
-- roster boards are people boards with the roster capabilities below, and
-- the database refuses a capability on a board whose type does not declare it.
--
-- Patterns are reusable recurring definitions (a repeating cycle of local
-- clock-time slots in a named time zone). An assignment applies a pattern
-- to one person on one people board over an effective window; generated
-- bookings carry the assignment, occurrence date and slot so regeneration
-- is idempotent and never rewrites past or manually changed bookings.
-- Pattern exceptions omit an occurrence or select the real instant of a
-- clock time repeated by a daylight-saving change.
--
-- A board may be governed from an effective date: bookings starting on or
-- after that date record governed = true when created. A governed booking
-- is published only by an approver independent of its preparers and of the
-- people it schedules, and once published it changes only through an
-- independently approved revision (a draft successor or a removal draft)
-- or an approved shift request.
--
-- Shift requests let an employee ask to release, change or swap their own
-- published booking. Approval applies the outcome atomically with the
-- booking ledger's availability, leave, qualification and double-booking
-- guards; approvals may additionally route through an optional Flow.
--
-- Attendance devices map source worker identifiers to people over dated
-- windows, admit idempotent check-in batches with completeness watermarks,
-- and observe presence against published bookings under an effective-dated
-- board attendance policy. Observations, claims and source events are
-- immutable evidence; corrections append successors.
--
-- Discarding a staged change no longer blocks later changes: a booking's
-- successor is unique among its live (non-cancelled) successors.
--
-- Backfill: none. New tables start empty; existing bookings keep
-- governed = false and no pattern, request or closing evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.openbooks_schedule_board_types (
 key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
 row_kind text NOT NULL CHECK (row_kind IN ('people','tasks','resources')),
 capabilities text[] NOT NULL CHECK (coalesce(array_ndims(capabilities), 1) = 1),
 added_in text NOT NULL
);
COMMENT ON TABLE public.openbooks_schedule_board_types IS
 'Scheduling board types: storage mirror of SCHEDULE_BOARD_TYPES (engine/src/schedule-boards/board-types.ts). A type names its row kind and the capabilities its boards enable; a migration that adds a type registers its row here.';
INSERT INTO public.openbooks_schedule_board_types (key, row_kind, capabilities, added_in) VALUES
 ('people', 'people', ARRAY['bookings']::text[], '0737'),
 ('tasks', 'tasks', ARRAY[]::text[], '0737'),
 ('resources', 'resources', ARRAY['bookings']::text[], '0737'),
 ('shift_roster', 'people', ARRAY['bookings','patterns','shift_requests','governed_publication','attendance','closing']::text[], '0737')
ON CONFLICT (key) DO NOTHING; -- expected on replay; the registry seed is idempotent

-- Every existing board keeps the standard type of its row kind.
ALTER TABLE public.schedule_boards ADD COLUMN board_type text;
UPDATE public.schedule_boards SET board_type = row_kind WHERE board_type IS NULL;
ALTER TABLE public.schedule_boards
 ALTER COLUMN board_type SET NOT NULL,
 ADD CONSTRAINT schedule_boards_board_type_fkey FOREIGN KEY (board_type) REFERENCES public.openbooks_schedule_board_types(key);
COMMENT ON COLUMN public.schedule_boards.board_type IS
 'The board''s registered type. It is fixed for the board''s life and decides which capabilities (patterns, shift requests, governed publication, attendance) the board offers.';

CREATE FUNCTION public.schedule_board_has_capability(tenant uuid, board uuid, capability text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $function$
 SELECT EXISTS (SELECT 1 FROM public.schedule_boards b JOIN public.openbooks_schedule_board_types t ON t.key = b.board_type
  WHERE b.org_id = tenant AND b.id = board AND capability = ANY (t.capabilities));
$function$;

-- Governed publication is a board policy with an effective date.
ALTER TABLE public.schedule_boards
 DROP CONSTRAINT schedule_boards_publish_policy_check,
 ADD CONSTRAINT schedule_boards_publish_policy_check CHECK (publish_policy IN ('live','staged','governed')),
 ADD COLUMN governed_from date,
 ADD CONSTRAINT schedule_boards_governed_from CHECK ((publish_policy = 'governed') = (governed_from IS NOT NULL)
  AND (governed_from IS NULL OR governed_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'));
COMMENT ON COLUMN public.schedule_boards.governed_from IS
 'First booking date governed by independent publication. Each booking records whether it is governed when it is created, so changing the policy never reinterprets existing bookings.';

-- A board's type is fixed, matches its row kind and declares every
-- capability the board uses.
CREATE FUNCTION public.schedule_boards_type_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE board_type public.openbooks_schedule_board_types;
BEGIN
 IF TG_OP = 'INSERT' AND NEW.board_type IS NULL THEN NEW.board_type := NEW.row_kind; END IF;
 IF TG_OP = 'UPDATE' AND NEW.board_type IS DISTINCT FROM OLD.board_type THEN
  RAISE EXCEPTION 'A board keeps its type; create a new board for a different kind of schedule.' USING ERRCODE = '23514';
 END IF;
 SELECT * INTO board_type FROM public.openbooks_schedule_board_types WHERE key = NEW.board_type;
 IF NOT FOUND OR board_type.row_kind <> NEW.row_kind THEN
  RAISE EXCEPTION 'The board type does not schedule this kind of row; choose a type for people, tasks or resources.' USING ERRCODE = '23514';
 END IF;
 IF NEW.publish_policy = 'governed' AND NOT ('governed_publication' = ANY (board_type.capabilities)) THEN
  RAISE EXCEPTION 'Governed publication is available on shift roster boards; choose live or staged publishing for this board.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_boards_type_guard BEFORE INSERT OR UPDATE ON public.schedule_boards
 FOR EACH ROW EXECUTE FUNCTION public.schedule_boards_type_guard();

-- A slot is {position, starts, ends, breakMinutes, qualificationTypeIds}:
-- a cycle day, local HH:MM clock times (an end at or before the start ends
-- the next day), a planned break and the native qualification types the
-- person must hold. Slots never overlap, including across the cycle boundary.
CREATE FUNCTION public.schedule_pattern_slots_valid(slots jsonb, cycle_days integer) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog AS $function$
DECLARE slot jsonb; qualification jsonb; seen text[]; slot_day integer; starts integer; ends integer; pause integer;
 cycle_minutes integer; from_minute integer; to_minute integer;
 intervals int4range[] := ARRAY[]::int4range[]; segment int4range; existing int4range;
BEGIN
 IF cycle_days IS NULL OR cycle_days NOT BETWEEN 1 AND 366 THEN RETURN false; END IF;
 IF jsonb_typeof(slots) IS DISTINCT FROM 'array' OR jsonb_array_length(slots) NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
 cycle_minutes := cycle_days * 1440;
 FOR slot IN SELECT value FROM jsonb_array_elements(slots) LOOP
  IF jsonb_typeof(slot) IS DISTINCT FROM 'object'
   OR NOT slot ?& ARRAY['position','starts','ends','breakMinutes','qualificationTypeIds']
   OR slot - ARRAY['position','starts','ends','breakMinutes','qualificationTypeIds'] <> '{}'::jsonb
   OR jsonb_typeof(slot->'position') IS DISTINCT FROM 'number' OR (slot->>'position') !~ '^[0-9]{1,3}$'
   OR jsonb_typeof(slot->'breakMinutes') IS DISTINCT FROM 'number' OR (slot->>'breakMinutes') !~ '^[0-9]{1,3}$'
   OR jsonb_typeof(slot->'starts') IS DISTINCT FROM 'string' OR (slot->>'starts') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
   OR jsonb_typeof(slot->'ends') IS DISTINCT FROM 'string' OR (slot->>'ends') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
   OR jsonb_typeof(slot->'qualificationTypeIds') IS DISTINCT FROM 'array' OR jsonb_array_length(slot->'qualificationTypeIds') > 100 THEN
   RETURN false;
  END IF;
  slot_day := (slot->>'position')::integer;
  pause := (slot->>'breakMinutes')::integer;
  starts := split_part(slot->>'starts', ':', 1)::integer * 60 + split_part(slot->>'starts', ':', 2)::integer;
  ends := split_part(slot->>'ends', ':', 1)::integer * 60 + split_part(slot->>'ends', ':', 2)::integer;
  IF ends <= starts THEN ends := ends + 1440; END IF;
  IF slot_day >= cycle_days OR pause > 240 OR pause >= ends - starts THEN RETURN false; END IF;
  seen := ARRAY[]::text[];
  FOR qualification IN SELECT value FROM jsonb_array_elements(slot->'qualificationTypeIds') LOOP
   IF jsonb_typeof(qualification) IS DISTINCT FROM 'string'
    OR (qualification#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (qualification#>>'{}') = ANY (seen) THEN
    RETURN false;
   END IF;
   seen := array_append(seen, qualification#>>'{}');
  END LOOP;
  from_minute := slot_day * 1440 + starts;
  to_minute := slot_day * 1440 + ends;
  FOR segment IN SELECT unnest(CASE WHEN to_minute > cycle_minutes
    THEN ARRAY[int4range(from_minute, cycle_minutes, '[)'), int4range(0, to_minute - cycle_minutes, '[)')]
    ELSE ARRAY[int4range(from_minute, to_minute, '[)')] END) LOOP
   FOREACH existing IN ARRAY intervals LOOP
    IF existing && segment THEN RETURN false; END IF;
   END LOOP;
   intervals := array_append(intervals, segment);
  END LOOP;
 END LOOP;
 RETURN true;
END $function$;

CREATE TABLE public.schedule_patterns (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid,
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code = btrim(code)),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160 AND name = btrim(name)),
 description text CHECK (description IS NULL OR length(description) <= 2000),
 time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
 cycle_days smallint NOT NULL,
 cycle_anchor date NOT NULL CHECK (cycle_anchor BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 slots jsonb NOT NULL,
 target_kind text CHECK (target_kind IN ('customer','project','location','code')),
 customer_party_id uuid,
 project_id uuid,
 project_task_id uuid,
 location_id uuid,
 schedule_code_id uuid,
 department_id uuid,
 detail text CHECK (detail IS NULL OR (length(btrim(detail)) BETWEEN 1 AND 120 AND detail = btrim(detail))),
 horizon_days smallint NOT NULL DEFAULT 28 CHECK (horizon_days BETWEEN 1 AND 366),
 is_active boolean NOT NULL DEFAULT true,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, customer_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id),
 FOREIGN KEY (org_id, project_id, project_task_id) REFERENCES public.project_tasks(org_id, project_id, id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id),
 FOREIGN KEY (org_id, schedule_code_id) REFERENCES public.schedule_codes(org_id, id),
 FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_patterns_slots CHECK (public.schedule_pattern_slots_valid(slots, cycle_days)),
 CONSTRAINT schedule_patterns_target CHECK (
   (target_kind IS NULL AND customer_party_id IS NULL AND project_id IS NULL AND location_id IS NULL AND schedule_code_id IS NULL)
   OR (target_kind = 'customer' AND customer_party_id IS NOT NULL AND project_id IS NULL AND location_id IS NULL AND schedule_code_id IS NULL)
   OR (target_kind = 'project' AND project_id IS NOT NULL AND customer_party_id IS NULL AND location_id IS NULL AND schedule_code_id IS NULL)
   OR (target_kind = 'location' AND location_id IS NOT NULL AND customer_party_id IS NULL AND project_id IS NULL AND schedule_code_id IS NULL)
   OR (target_kind = 'code' AND schedule_code_id IS NOT NULL AND customer_party_id IS NULL AND project_id IS NULL AND location_id IS NULL)),
 CONSTRAINT schedule_patterns_task_needs_project CHECK (project_task_id IS NULL OR project_id IS NOT NULL)
);
CREATE UNIQUE INDEX schedule_patterns_code_key ON public.schedule_patterns
 (org_id, coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
COMMENT ON TABLE public.schedule_patterns IS
 'Recurring shift patterns: a repeating cycle of local clock-time slots in a named time zone with an optional booking target, generated horizon_days ahead. Assignments apply a pattern to a person on a people board; editing a pattern changes only future generation.';

CREATE TABLE public.schedule_pattern_assignments (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 board_id uuid NOT NULL,
 pattern_id uuid NOT NULL,
 worker_party_id uuid NOT NULL,
 employment_id uuid,
 subsidiary_id uuid,
 effective_from date NOT NULL CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 effective_to date CHECK (effective_to > effective_from AND effective_to <= DATE '9999-12-31'),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','cancelled')),
 generated_through date,
 last_generation jsonb CHECK (last_generation IS NULL OR jsonb_typeof(last_generation) = 'object'),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, board_id) REFERENCES public.schedule_boards(org_id, id),
 FOREIGN KEY (org_id, pattern_id) REFERENCES public.schedule_patterns(org_id, id),
 FOREIGN KEY (org_id, worker_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_pattern_assignments_ended CHECK (status <> 'ended' OR effective_to IS NOT NULL),
 CONSTRAINT schedule_pattern_assignments_no_overlap EXCLUDE USING gist (
  org_id WITH =, worker_party_id WITH =, pattern_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
  WHERE (status IN ('active','ended'))
);
CREATE INDEX schedule_pattern_assignments_board ON public.schedule_pattern_assignments(org_id, board_id, status);
CREATE INDEX schedule_pattern_assignments_worker ON public.schedule_pattern_assignments(org_id, worker_party_id);
COMMENT ON TABLE public.schedule_pattern_assignments IS
 'A person working a recurring pattern on a people board over a half-open effective window. generated_through records how far bookings have been generated and last_generation summarizes the latest run, including occurrences that could not be booked.';

CREATE TABLE public.schedule_pattern_exceptions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 assignment_id uuid NOT NULL,
 occurs_on date NOT NULL CHECK (occurs_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 slot_index smallint NOT NULL CHECK (slot_index BETWEEN 0 AND 999),
 kind text NOT NULL CHECK (kind IN ('omit','select_instant')),
 starts_at timestamptz,
 ends_at timestamptz,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 revoked_at timestamptz, revoked_by uuid, revoke_reason text,
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, assignment_id) REFERENCES public.schedule_pattern_assignments(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, revoked_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_pattern_exceptions_kind CHECK (
  (kind = 'omit' AND starts_at IS NULL AND ends_at IS NULL)
  OR (kind = 'select_instant' AND starts_at IS NOT NULL AND ends_at > starts_at AND ends_at - starts_at <= interval '48 hours'
      AND starts_at = date_trunc('milliseconds', starts_at) AND ends_at = date_trunc('milliseconds', ends_at))),
 CONSTRAINT schedule_pattern_exceptions_revocation CHECK (
  (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
  OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND length(btrim(revoke_reason)) BETWEEN 1 AND 2000))
);
CREATE UNIQUE INDEX schedule_pattern_exceptions_active ON public.schedule_pattern_exceptions(org_id, assignment_id, occurs_on, slot_index)
 WHERE revoked_at IS NULL;
COMMENT ON TABLE public.schedule_pattern_exceptions IS
 'Occurrence decisions for a pattern assignment: an omission with its reason, or the selected instants of a clock time a daylight-saving change repeats. Revocation is recorded, never deleted.';

CREATE TABLE public.schedule_entry_requests (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 board_id uuid NOT NULL,
 entry_id uuid NOT NULL,
 entry_revision integer NOT NULL CHECK (entry_revision > 0),
 worker_party_id uuid NOT NULL,
 subsidiary_id uuid,
 kind text NOT NULL CHECK (kind IN ('release','change','swap')),
 proposed_starts_at timestamptz,
 proposed_ends_at timestamptz,
 proposed_break_minutes smallint CHECK (proposed_break_minutes BETWEEN 0 AND 240),
 counterpart_entry_id uuid,
 counterpart_entry_revision integer CHECK (counterpart_entry_revision > 0),
 counterpart_party_id uuid,
 counterpart_responded_by uuid,
 counterpart_responded_at timestamptz,
 status text NOT NULL CHECK (status IN ('awaiting_counterpart','pending','approved','declined','withdrawn')),
 flow_run_id uuid,
 decided_by uuid,
 decided_at timestamptz,
 decision_reason text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 1 AND 2000),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, board_id) REFERENCES public.schedule_boards(org_id, id),
 FOREIGN KEY (org_id, entry_id) REFERENCES public.schedule_entries(org_id, id),
 FOREIGN KEY (org_id, counterpart_entry_id) REFERENCES public.schedule_entries(org_id, id),
 FOREIGN KEY (org_id, worker_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, counterpart_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, counterpart_responded_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, decided_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_entry_requests_shape CHECK (
  (kind = 'release' AND proposed_starts_at IS NULL AND proposed_ends_at IS NULL AND proposed_break_minutes IS NULL
    AND counterpart_entry_id IS NULL AND counterpart_entry_revision IS NULL AND counterpart_party_id IS NULL)
  OR (kind = 'change' AND proposed_starts_at IS NOT NULL AND proposed_ends_at > proposed_starts_at
    AND proposed_ends_at - proposed_starts_at <= interval '48 hours' AND proposed_break_minutes IS NOT NULL
    AND proposed_break_minutes * 60 < extract(epoch FROM proposed_ends_at - proposed_starts_at)
    AND proposed_starts_at = date_trunc('milliseconds', proposed_starts_at) AND proposed_ends_at = date_trunc('milliseconds', proposed_ends_at)
    AND counterpart_entry_id IS NULL AND counterpart_entry_revision IS NULL AND counterpart_party_id IS NULL)
  OR (kind = 'swap' AND proposed_starts_at IS NULL AND proposed_ends_at IS NULL AND proposed_break_minutes IS NULL
    AND counterpart_entry_id IS NOT NULL AND counterpart_entry_revision IS NOT NULL AND counterpart_party_id IS NOT NULL
    AND counterpart_entry_id <> entry_id AND counterpart_party_id <> worker_party_id)),
 CONSTRAINT schedule_entry_requests_counterpart_response CHECK (
  (counterpart_responded_by IS NULL) = (counterpart_responded_at IS NULL)
  AND (status <> 'awaiting_counterpart' OR kind = 'swap')
  AND (kind <> 'swap' OR status NOT IN ('pending','approved') OR counterpart_responded_by IS NOT NULL)
  AND (kind = 'swap' OR counterpart_responded_by IS NULL)),
 CONSTRAINT schedule_entry_requests_decision CHECK (
  (decided_by IS NULL) = (decided_at IS NULL)
  AND ((status IN ('approved','declined')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL)))
);
CREATE UNIQUE INDEX schedule_entry_requests_open_entry ON public.schedule_entry_requests(org_id, entry_id)
 WHERE status IN ('awaiting_counterpart','pending');
CREATE UNIQUE INDEX schedule_entry_requests_open_counterpart ON public.schedule_entry_requests(org_id, counterpart_entry_id)
 WHERE status IN ('awaiting_counterpart','pending') AND counterpart_entry_id IS NOT NULL;
CREATE INDEX schedule_entry_requests_board ON public.schedule_entry_requests(org_id, board_id, status, created_at);
CREATE INDEX schedule_entry_requests_worker ON public.schedule_entry_requests(org_id, worker_party_id, created_at);
CREATE INDEX schedule_entry_requests_counterpart ON public.schedule_entry_requests(org_id, counterpart_party_id, created_at)
 WHERE counterpart_party_id IS NOT NULL;
COMMENT ON TABLE public.schedule_entry_requests IS
 'Employee requests to release, change or swap their own published booking. A swap first needs the colleague''s acceptance; an independent approver decides, and approval applies the outcome in the same transaction.';

-- Bookings: governance, pattern provenance, request outcomes, removal
-- revisions, required qualifications and formal closing.
ALTER TABLE public.schedule_entries
 ADD COLUMN governed boolean NOT NULL DEFAULT false,
 ADD COLUMN pattern_assignment_id uuid,
 ADD COLUMN pattern_occurs_on date,
 ADD COLUMN pattern_slot smallint,
 ADD COLUMN pattern_override boolean NOT NULL DEFAULT false,
 ADD COLUMN origin_request_id uuid,
 ADD COLUMN removes_predecessor boolean NOT NULL DEFAULT false,
 ADD COLUMN required_qualification_type_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
 ADD COLUMN closed_at timestamptz,
 ADD COLUMN closed_by uuid,
 ADD COLUMN close_reason text,
 ADD CONSTRAINT schedule_entries_pattern_assignment_fkey FOREIGN KEY (org_id, pattern_assignment_id)
  REFERENCES public.schedule_pattern_assignments(org_id, id),
 ADD CONSTRAINT schedule_entries_closed_by_fkey FOREIGN KEY (org_id, closed_by) REFERENCES public.users(org_id, id),
 ADD CONSTRAINT schedule_entries_pattern_key CHECK (
  (pattern_assignment_id IS NULL AND pattern_occurs_on IS NULL AND pattern_slot IS NULL AND NOT pattern_override)
  OR (pattern_assignment_id IS NOT NULL AND pattern_occurs_on IS NOT NULL AND pattern_slot BETWEEN 0 AND 999)),
 ADD CONSTRAINT schedule_entries_removal CHECK (NOT removes_predecessor
  OR (supersedes_id IS NOT NULL AND status IN ('draft','cancelled') AND pattern_assignment_id IS NULL AND origin_request_id IS NULL)),
 ADD CONSTRAINT schedule_entries_qualifications CHECK (coalesce(array_ndims(required_qualification_type_ids), 1) = 1
  AND coalesce(array_length(required_qualification_type_ids, 1), 0) <= 100),
 ADD CONSTRAINT schedule_entries_closing CHECK (
  (closed_at IS NULL AND closed_by IS NULL AND close_reason IS NULL)
  OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND status = 'published' AND length(btrim(close_reason)) BETWEEN 1 AND 2000)),
 DROP CONSTRAINT schedule_entries_org_id_supersedes_id_key;
CREATE UNIQUE INDEX schedule_entries_org_id_supersedes_id_key ON public.schedule_entries(org_id, supersedes_id)
 WHERE supersedes_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX schedule_entries_supersedes ON public.schedule_entries(org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX schedule_entries_pattern_published ON public.schedule_entries(org_id, pattern_assignment_id, pattern_occurs_on, pattern_slot)
 WHERE pattern_assignment_id IS NOT NULL AND status = 'published';
CREATE UNIQUE INDEX schedule_entries_pattern_draft ON public.schedule_entries(org_id, pattern_assignment_id, pattern_occurs_on, pattern_slot)
 WHERE pattern_assignment_id IS NOT NULL AND status = 'draft';
CREATE INDEX schedule_entries_pattern ON public.schedule_entries(org_id, pattern_assignment_id, pattern_occurs_on)
 WHERE pattern_assignment_id IS NOT NULL;
COMMENT ON COLUMN public.schedule_entries.governed IS
 'Recorded when the booking is created from its board''s governed-from date. Governed bookings publish only through an independent approver and change only through approved revisions or shift requests.';
COMMENT ON COLUMN public.schedule_entries.pattern_override IS
 'True when a person changed a pattern-generated booking on the board; regeneration keeps the change.';
COMMENT ON COLUMN public.schedule_entries.origin_request_id IS
 'The approved shift request whose outcome this booking is. The booking guard admits it only for an approved request of the same organization and board decided by the booking''s publisher; requests reference their bookings, so this side carries no foreign key and the two never form a reference cycle.';
COMMENT ON COLUMN public.schedule_entries.removes_predecessor IS
 'A draft revision that removes the governed published booking it supersedes once an independent approver applies it.';

-- Attendance: devices, dated identities, policies, batches, events,
-- watermarks, observations and their event attribution.
CREATE TABLE public.schedule_attendance_devices (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code = btrim(code)),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160 AND name = btrim(name)),
 time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
 is_active boolean NOT NULL DEFAULT true,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, code),
 UNIQUE (org_id, subsidiary_id, id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id)
);
COMMENT ON TABLE public.schedule_attendance_devices IS
 'Time-clock sources of a legal entity. The code, legal entity and source time zone are fixed; a changed source is a new device.';

CREATE TABLE public.schedule_attendance_identities (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 device_id uuid NOT NULL,
 source_worker_id text NOT NULL CHECK (length(btrim(source_worker_id)) BETWEEN 1 AND 160 AND source_worker_id = btrim(source_worker_id)),
 subsidiary_id uuid NOT NULL,
 worker_party_id uuid NOT NULL,
 employment_id uuid,
 effective_from date NOT NULL CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 effective_to date CHECK (effective_to > effective_from AND effective_to <= DATE '9999-12-31'),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, device_id, id),
 FOREIGN KEY (org_id, subsidiary_id, device_id) REFERENCES public.schedule_attendance_devices(org_id, subsidiary_id, id),
 FOREIGN KEY (org_id, worker_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_attendance_identities_source_window EXCLUDE USING gist (
  org_id WITH =, device_id WITH =, source_worker_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&),
 CONSTRAINT schedule_attendance_identities_person_window EXCLUDE USING gist (
  org_id WITH =, device_id WITH =, worker_party_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
);
CREATE INDEX schedule_attendance_identities_worker ON public.schedule_attendance_identities(org_id, worker_party_id);
COMMENT ON TABLE public.schedule_attendance_identities IS
 'A device''s source worker identifier mapped to one person over a half-open date window in the device time zone. Employment is recorded when the person has one.';

CREATE TABLE public.schedule_attendance_policies (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 board_id uuid NOT NULL,
 effective_from date NOT NULL CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 capture_before_minutes smallint NOT NULL CHECK (capture_before_minutes BETWEEN 0 AND 720),
 capture_after_minutes smallint NOT NULL CHECK (capture_after_minutes BETWEEN 0 AND 720),
 late_grace_minutes smallint NOT NULL CHECK (late_grace_minutes BETWEEN 0 AND 720),
 early_grace_minutes smallint NOT NULL CHECK (early_grace_minutes BETWEEN 0 AND 720),
 break_grace_minutes smallint NOT NULL CHECK (break_grace_minutes BETWEEN 0 AND 720),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, board_id, effective_from),
 FOREIGN KEY (org_id, board_id) REFERENCES public.schedule_boards(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
COMMENT ON TABLE public.schedule_attendance_policies IS
 'Effective-dated attendance capture windows and grace bounds for a board. A booking is observed under the version effective on its start date; versions are immutable.';

CREATE TABLE public.schedule_attendance_batches (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 device_id uuid NOT NULL,
 complete_through timestamptz CHECK (complete_through IS NULL OR (complete_through BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
  AND complete_through = date_trunc('milliseconds', complete_through))),
 is_correction boolean NOT NULL DEFAULT false,
 source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence) = 'object'),
 event_count integer NOT NULL CHECK (event_count BETWEEN 0 AND 10000),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, device_id, id),
 FOREIGN KEY (org_id, device_id) REFERENCES public.schedule_attendance_devices(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);

CREATE TABLE public.schedule_attendance_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 device_id uuid NOT NULL,
 batch_id uuid NOT NULL,
 identity_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL,
 worker_party_id uuid NOT NULL,
 employment_id uuid,
 source_event_id text NOT NULL CHECK (length(btrim(source_event_id)) BETWEEN 1 AND 160),
 source_version integer NOT NULL CHECK (source_version > 0),
 kind text NOT NULL CHECK (kind IN ('clock_in','clock_out','break_start','break_end','void')),
 occurred_at timestamptz NOT NULL CHECK (occurred_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
  AND occurred_at = date_trunc('milliseconds', occurred_at)),
 source_local_date date NOT NULL CHECK (source_local_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 source_payload jsonb NOT NULL CHECK (jsonb_typeof(source_payload) = 'object'),
 supersedes_id uuid,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, device_id, source_event_id, id),
 UNIQUE (org_id, device_id, source_event_id, source_version),
 UNIQUE (org_id, supersedes_id),
 FOREIGN KEY (org_id, device_id, batch_id) REFERENCES public.schedule_attendance_batches(org_id, device_id, id),
 FOREIGN KEY (org_id, device_id, identity_id) REFERENCES public.schedule_attendance_identities(org_id, device_id, id),
 FOREIGN KEY (org_id, device_id, source_event_id, supersedes_id) REFERENCES public.schedule_attendance_events(org_id, device_id, source_event_id, id),
 FOREIGN KEY (org_id, worker_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_attendance_events_version CHECK (
  (source_version = 1 AND supersedes_id IS NULL AND kind <> 'void') OR (source_version > 1 AND supersedes_id IS NOT NULL))
);
CREATE INDEX schedule_attendance_events_worker_time ON public.schedule_attendance_events(org_id, worker_party_id, occurred_at);

CREATE TABLE public.schedule_attendance_watermarks (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 device_id uuid NOT NULL,
 batch_id uuid NOT NULL,
 complete_through timestamptz NOT NULL CHECK (complete_through BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
  AND complete_through = date_trunc('milliseconds', complete_through)),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, device_id),
 FOREIGN KEY (org_id, device_id, batch_id) REFERENCES public.schedule_attendance_batches(org_id, device_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id)
);

CREATE TABLE public.schedule_attendance_observations (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 entry_id uuid NOT NULL,
 board_id uuid NOT NULL,
 policy_id uuid,
 subsidiary_id uuid,
 worker_party_id uuid NOT NULL,
 employment_id uuid,
 status text NOT NULL CHECK (status IN ('waiting_for_sync','absent','present','voided')),
 complete_through timestamptz,
 first_in timestamptz,
 last_out timestamptz,
 presence_milliseconds bigint CHECK (presence_milliseconds >= 0),
 break_milliseconds bigint CHECK (break_milliseconds >= 0),
 late boolean,
 left_early boolean,
 over_break boolean,
 source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence) = 'object'),
 evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
 supersedes_id uuid,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, entry_id, id),
 UNIQUE (org_id, supersedes_id),
 FOREIGN KEY (org_id, entry_id) REFERENCES public.schedule_entries(org_id, id),
 FOREIGN KEY (org_id, board_id) REFERENCES public.schedule_boards(org_id, id),
 FOREIGN KEY (org_id, policy_id) REFERENCES public.schedule_attendance_policies(org_id, id),
 FOREIGN KEY (org_id, entry_id, supersedes_id) REFERENCES public.schedule_attendance_observations(org_id, entry_id, id),
 FOREIGN KEY (org_id, worker_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_attendance_observations_outcome CHECK (
  (status IN ('waiting_for_sync','voided') AND presence_milliseconds IS NULL AND break_milliseconds IS NULL AND late IS NULL
    AND left_early IS NULL AND over_break IS NULL AND first_in IS NULL AND last_out IS NULL)
  OR (status = 'absent' AND presence_milliseconds = 0 AND break_milliseconds = 0 AND late = false AND left_early = false
    AND over_break = false AND first_in IS NULL AND last_out IS NULL)
  OR (status = 'present' AND presence_milliseconds IS NOT NULL AND break_milliseconds IS NOT NULL AND late IS NOT NULL
    AND left_early IS NOT NULL AND over_break IS NOT NULL AND first_in IS NOT NULL AND last_out > first_in
    AND presence_milliseconds + break_milliseconds <= extract(epoch FROM last_out - first_in) * 1000)),
 CONSTRAINT schedule_attendance_observations_policy CHECK (status = 'voided' OR policy_id IS NOT NULL)
);
CREATE UNIQUE INDEX schedule_attendance_observations_first ON public.schedule_attendance_observations(org_id, entry_id)
 WHERE supersedes_id IS NULL;
CREATE INDEX schedule_attendance_observations_board ON public.schedule_attendance_observations(org_id, board_id, created_at);

CREATE TABLE public.schedule_attendance_event_claims (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 event_id uuid NOT NULL,
 entry_id uuid NOT NULL,
 released_at timestamptz, released_by uuid, release_reason text,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, event_id) REFERENCES public.schedule_attendance_events(org_id, id),
 FOREIGN KEY (org_id, entry_id) REFERENCES public.schedule_entries(org_id, id),
 FOREIGN KEY (org_id, released_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_attendance_event_claims_release CHECK (
  (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
  OR (released_at IS NOT NULL AND released_by IS NOT NULL AND length(btrim(release_reason)) BETWEEN 1 AND 2000))
);
CREATE UNIQUE INDEX schedule_attendance_event_claims_active ON public.schedule_attendance_event_claims(org_id, event_id)
 WHERE released_at IS NULL;
CREATE INDEX schedule_attendance_event_claims_entry ON public.schedule_attendance_event_claims(org_id, entry_id) WHERE released_at IS NULL;

CREATE TABLE public.schedule_attendance_observation_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 observation_id uuid NOT NULL,
 event_claim_id uuid NOT NULL,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, observation_id, event_claim_id),
 FOREIGN KEY (org_id, observation_id) REFERENCES public.schedule_attendance_observations(org_id, id),
 FOREIGN KEY (org_id, event_claim_id) REFERENCES public.schedule_attendance_event_claims(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);

-- Governed publication: the approver is an active person who neither
-- prepared the change nor is scheduled by it.
CREATE FUNCTION public.schedule_assert_independent(tenant uuid, reviewer uuid, authors uuid[], subjects uuid[]) RETURNS void
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE reviewer_party uuid;
BEGIN
 SELECT party_id INTO reviewer_party FROM public.users WHERE org_id = tenant AND id = reviewer AND is_active FOR SHARE;
 IF reviewer_party IS NULL OR reviewer = ANY (authors) OR reviewer_party = ANY (subjects)
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.org_id = tenant AND u.id = ANY (authors) AND u.party_id = reviewer_party) THEN
  RAISE EXCEPTION 'Governed schedules need an independent approver; link the approver''s login to their person record and choose someone who neither prepared this change nor is scheduled by it.' USING ERRCODE = '23514';
 END IF;
END $function$;

-- Required qualifications are verified for every date the booking covers.
CREATE FUNCTION public.schedule_entry_assert_qualified(entry public.schedule_entries) RETURNS void
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE type_row public.hrm_qualification_types; required uuid; last_date date;
BEGIN
 IF coalesce(array_length(entry.required_qualification_type_ids, 1), 0) = 0 THEN RETURN; END IF;
 last_date := ((entry.ends_at - interval '1 millisecond') AT TIME ZONE entry.time_zone)::date;
 FOREACH required IN ARRAY entry.required_qualification_type_ids LOOP
  SELECT * INTO type_row FROM public.hrm_qualification_types WHERE org_id = entry.org_id AND id = required AND is_active FOR SHARE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'A required qualification type is unavailable; reactivate it or remove the requirement from the pattern slot.' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.hrm_worker_qualifications q JOIN public.worker_employments e ON e.org_id = q.org_id AND e.id = q.employment_id
   WHERE q.org_id = entry.org_id AND e.worker_party_id = entry.worker_party_id
     AND (entry.employment_id IS NULL OR q.employment_id = entry.employment_id)
     AND q.type_id = required AND q.status = 'valid' AND q.verified_by IS NOT NULL AND q.verified_at IS NOT NULL
     AND q.issued_on <= entry.starts_on AND (q.expires_on IS NULL OR q.expires_on >= last_date)
   FOR SHARE OF q;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Qualification % (%) is not verified for the whole booking; record, renew or verify the person''s qualification before publishing.', type_row.name, type_row.code USING ERRCODE = '23514';
  END IF;
 END LOOP;
END $function$;

-- Formal closing needs an ended booking with current, complete attendance.
CREATE FUNCTION public.schedule_entry_assert_closable(entry public.schedule_entries) RETURNS void
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE features jsonb; observation_row public.schedule_attendance_observations; policy_row public.schedule_attendance_policies;
 capture_from timestamptz; capture_to timestamptz; mapped integer; pending integer; expected_ids uuid[]; linked_ids uuid[];
BEGIN
 IF NOT public.schedule_board_has_capability(entry.org_id, entry.board_id, 'closing') THEN
  RAISE EXCEPTION 'Formal closing applies to shifts on shift roster boards.' USING ERRCODE = '23514';
 END IF;
 SELECT settings->'features' INTO features FROM public.orgs WHERE id = entry.org_id FOR SHARE;
 IF features->'hrm' IS DISTINCT FROM 'true'::jsonb OR features->'hrmShiftPlanning' IS DISTINCT FROM 'true'::jsonb
    OR features->'hrmAttendance' IS DISTINCT FROM 'true'::jsonb OR features->'hrmShiftClosing' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'Formal shift closing is disabled; enable it and Device attendance on Company Settings → Features. Published bookings do not require closing.' USING ERRCODE = '23514';
 END IF;
 IF entry.worker_party_id IS NULL OR entry.ends_at > now() THEN
  RAISE EXCEPTION 'Only a person''s ended booking can be closed; wait until the shift ends.' USING ERRCODE = '23514';
 END IF;
 SELECT * INTO observation_row FROM public.schedule_attendance_observations o WHERE o.org_id = entry.org_id AND o.entry_id = entry.id
  AND NOT EXISTS (SELECT 1 FROM public.schedule_attendance_observations n WHERE n.org_id = o.org_id AND n.supersedes_id = o.id) FOR SHARE;
 IF observation_row.id IS NULL OR observation_row.status NOT IN ('absent','present') THEN
  RAISE EXCEPTION 'Attendance has no current completed observation; synchronize the mapped devices and process attendance before closing.' USING ERRCODE = '23514';
 END IF;
 SELECT * INTO policy_row FROM public.schedule_attendance_policies WHERE org_id = entry.org_id AND id = observation_row.policy_id;
 capture_from := entry.starts_at - make_interval(mins => policy_row.capture_before_minutes);
 capture_to := entry.ends_at + make_interval(mins => policy_row.capture_after_minutes);
 SELECT count(*), count(*) FILTER (WHERE w.complete_through IS NULL OR w.complete_through < capture_to) INTO mapped, pending
  FROM public.schedule_attendance_identities i
  JOIN public.schedule_attendance_devices d ON d.org_id = i.org_id AND d.id = i.device_id
  LEFT JOIN public.schedule_attendance_watermarks w ON w.org_id = i.org_id AND w.device_id = i.device_id
  WHERE i.org_id = entry.org_id AND i.worker_party_id = entry.worker_party_id
    AND daterange(i.effective_from, i.effective_to, '[)') @> daterange((capture_from AT TIME ZONE d.time_zone)::date, (capture_to AT TIME ZONE d.time_zone)::date, '[]');
 IF mapped = 0 OR pending > 0 THEN
  RAISE EXCEPTION 'Attendance sources are not complete for this booking; synchronize every mapped device and process attendance before closing.' USING ERRCODE = '23514';
 END IF;
 SELECT coalesce(array_agg(e.id ORDER BY e.id), ARRAY[]::uuid[]) INTO expected_ids FROM public.schedule_attendance_events e
  WHERE e.org_id = entry.org_id AND e.worker_party_id = entry.worker_party_id AND e.occurred_at BETWEEN capture_from AND capture_to AND e.kind <> 'void'
    AND NOT EXISTS (SELECT 1 FROM public.schedule_attendance_events n WHERE n.org_id = e.org_id AND n.supersedes_id = e.id);
 SELECT coalesce(array_agg(c.event_id ORDER BY c.event_id), ARRAY[]::uuid[]) INTO linked_ids FROM public.schedule_attendance_observation_events oe
  JOIN public.schedule_attendance_event_claims c ON c.org_id = oe.org_id AND c.id = oe.event_claim_id
  WHERE oe.org_id = entry.org_id AND oe.observation_id = observation_row.id AND c.released_at IS NULL;
 IF expected_ids IS DISTINCT FROM linked_ids THEN
  RAISE EXCEPTION 'Attendance evidence changed after it was processed; process attendance again before closing.' USING ERRCODE = '23514';
 END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.schedule_entries_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE board public.schedule_boards; prior public.schedule_entries; successor public.schedule_entries;
 request_row public.schedule_entry_requests; assignment_row public.schedule_pattern_assignments; last_date date; editable text[];
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Booking history cannot be deleted; cancel the booking instead.' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 -- A governed project merge re-points project references only; every other
 -- booking fact, including its revision, is preserved.
 IF TG_OP = 'UPDATE' AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on'
    AND coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
    AND to_jsonb(NEW) - ARRAY['project_id','project_task_id'] = to_jsonb(OLD) - ARRAY['project_id','project_task_id'] THEN
  RETURN NEW;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF ROW(NEW.id, NEW.org_id, NEW.board_id, NEW.created_at, NEW.created_by, NEW.request_hash, NEW.supersedes_id,
         NEW.pattern_assignment_id, NEW.pattern_occurs_on, NEW.pattern_slot, NEW.origin_request_id, NEW.removes_predecessor)
     IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.board_id, OLD.created_at, OLD.created_by, OLD.request_hash, OLD.supersedes_id,
         OLD.pattern_assignment_id, OLD.pattern_occurs_on, OLD.pattern_slot, OLD.origin_request_id, OLD.removes_predecessor) THEN
   RAISE EXCEPTION 'A booking keeps its board, creation evidence, predecessor and origin; create a new booking instead.' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
   RAISE EXCEPTION 'The booking changed since it was loaded; reload the board and try again.' USING ERRCODE = '40001';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
   RAISE EXCEPTION 'A closed shift is final history; record attendance corrections as new evidence instead.' USING ERRCODE = '23514';
  END IF;
 END IF;
 SELECT * INTO board FROM public.schedule_boards WHERE org_id = NEW.org_id AND id = NEW.board_id FOR SHARE;
 IF NOT FOUND OR board.row_kind NOT IN ('people','resources') THEN
  RAISE EXCEPTION 'Bookings belong to a people or resource board; select a booking board.' USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone)
    OR NEW.starts_on <> (NEW.starts_at AT TIME ZONE NEW.time_zone)::date
    OR NEW.ends_on <> (NEW.ends_at AT TIME ZONE NEW.time_zone)::date THEN
  RAISE EXCEPTION 'Booking dates do not match their time zone; select the booking times again.' USING ERRCODE = '23514';
 END IF;
 last_date := ((NEW.ends_at - interval '1 millisecond') AT TIME ZONE NEW.time_zone)::date;
 -- Governance is recorded from the board when the booking is created or
 -- while it is a draft; a published booking keeps it.
 IF TG_OP = 'INSERT' OR OLD.status = 'draft' THEN
  NEW.governed := board.publish_policy = 'governed' AND NEW.starts_on >= board.governed_from;
 ELSIF NEW.governed IS DISTINCT FROM OLD.governed THEN
  RAISE EXCEPTION 'A published booking keeps its governance.' USING ERRCODE = '23514';
 END IF;

 IF TG_OP = 'INSERT' THEN
  IF NOT board.is_active THEN
   RAISE EXCEPTION 'This board is archived; reactivate it in Setup before booking.' USING ERRCODE = '23514';
  END IF;
  IF NEW.closed_at IS NOT NULL THEN
   RAISE EXCEPTION 'A booking is closed only after its attendance is complete.' USING ERRCODE = '23514';
  END IF;
  IF NEW.removes_predecessor AND NEW.status <> 'draft' THEN
   RAISE EXCEPTION 'A removal revision starts as a draft that names the published booking it removes.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'published' THEN
   IF NEW.origin_request_id IS NOT NULL THEN
    SELECT * INTO request_row FROM public.schedule_entry_requests WHERE org_id = NEW.org_id AND id = NEW.origin_request_id FOR SHARE;
    IF NOT FOUND OR request_row.status <> 'approved' OR request_row.board_id <> NEW.board_id
       OR request_row.decided_by IS DISTINCT FROM NEW.published_by OR NEW.published_by IS DISTINCT FROM NEW.created_by
       OR NEW.supersedes_id IS NULL OR NEW.supersedes_id NOT IN (request_row.entry_id, coalesce(request_row.counterpart_entry_id, request_row.entry_id)) THEN
     RAISE EXCEPTION 'A shift request outcome is published by its approver in the approval command; reload the request.' USING ERRCODE = '23514';
    END IF;
   ELSE
    IF board.publish_policy <> 'live' THEN
     RAISE EXCEPTION 'This board publishes changes together; save the booking as a draft and publish the board.' USING ERRCODE = '23514';
    END IF;
    IF NEW.published_by IS DISTINCT FROM NEW.created_by THEN
     RAISE EXCEPTION 'Publication evidence must name the person who booked it.' USING ERRCODE = '23514';
    END IF;
   END IF;
  ELSIF NEW.status <> 'draft' OR NEW.published_by IS NOT NULL THEN
   RAISE EXCEPTION 'New bookings start as drafts or, on live boards, as published bookings.' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
   SELECT * INTO prior FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.supersedes_id FOR SHARE;
   IF prior.board_id IS DISTINCT FROM NEW.board_id OR prior.status = 'draft'
      OR (NEW.status = 'published' AND prior.status <> 'cancelled') THEN
    RAISE EXCEPTION 'A replacement booking supersedes a published or cancelled booking on the same board; reload the board.' USING ERRCODE = '23514';
   END IF;
   IF prior.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A closed shift is final history; book a new shift instead.' USING ERRCODE = '23514';
   END IF;
   IF NEW.removes_predecessor AND (prior.status <> 'published' OR ROW(NEW.worker_party_id, NEW.equipment_unit_id, NEW.resource_location_id, NEW.starts_at, NEW.ends_at)
      IS DISTINCT FROM ROW(prior.worker_party_id, prior.equipment_unit_id, prior.resource_location_id, prior.starts_at, prior.ends_at)) THEN
    RAISE EXCEPTION 'A removal revision names the published booking it removes, with the same subject and times.' USING ERRCODE = '23514';
   END IF;
  END IF;
  IF NEW.pattern_assignment_id IS NOT NULL THEN
   SELECT * INTO assignment_row FROM public.schedule_pattern_assignments WHERE org_id = NEW.org_id AND id = NEW.pattern_assignment_id FOR SHARE;
   IF NOT FOUND OR assignment_row.board_id <> NEW.board_id OR assignment_row.worker_party_id IS DISTINCT FROM NEW.worker_party_id
      OR assignment_row.employment_id IS DISTINCT FROM NEW.employment_id
      OR NEW.pattern_occurs_on < assignment_row.effective_from
      OR (assignment_row.effective_to IS NOT NULL AND NEW.pattern_occurs_on >= assignment_row.effective_to)
      OR (assignment_row.status = 'cancelled' AND NOT NEW.pattern_override) THEN
    RAISE EXCEPTION 'A pattern booking belongs to its assignment''s board, person and effective window; reload the assignment.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF OLD.status = 'draft' THEN
  IF NEW.status = 'published' THEN
   IF NEW.removes_predecessor THEN
    RAISE EXCEPTION 'A removal revision is applied by cancelling the booking it removes, not published.' USING ERRCODE = '23514';
   END IF;
   IF NEW.published_by IS DISTINCT FROM NEW.updated_by OR NEW.published_at IS NULL THEN
    RAISE EXCEPTION 'Publication evidence must name the publisher.' USING ERRCODE = '23514';
   END IF;
   IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.supersedes_id AND status = 'cancelled') THEN
    RAISE EXCEPTION 'Publishing a replacement cancels the booking it replaces in the same command.' USING ERRCODE = '23514';
   END IF;
   IF NEW.governed THEN
    PERFORM public.schedule_assert_independent(NEW.org_id, NEW.published_by, ARRAY[OLD.created_by, OLD.updated_by],
     ARRAY[NEW.worker_party_id]);
   END IF;
  ELSIF NEW.status NOT IN ('draft','cancelled') OR NEW.published_by IS NOT NULL THEN
   RAISE EXCEPTION 'A draft booking can be edited, published or cancelled.' USING ERRCODE = '23514';
  END IF;
  IF NEW.removes_predecessor AND NEW.status = 'draft' THEN
   RAISE EXCEPTION 'A removal revision cannot be edited; discard it and record another change.' USING ERRCODE = '23514';
  END IF;
  IF NEW.closed_at IS NOT NULL THEN
   RAISE EXCEPTION 'A booking is closed only after it is published and its attendance is complete.' USING ERRCODE = '23514';
  END IF;
 ELSIF OLD.status = 'published' THEN
  editable := ARRAY['status','notes','reason','revision','updated_at','updated_by','closed_at','closed_by','close_reason'];
  IF to_jsonb(NEW) - editable IS DISTINCT FROM to_jsonb(OLD) - editable OR NEW.status NOT IN ('published','cancelled') THEN
   RAISE EXCEPTION 'A published booking keeps its person or resource, target and times; change it on the board, which records a replacement.' USING ERRCODE = '23514';
  END IF;
  IF NEW.closed_at IS NOT NULL THEN
   IF NEW.status <> 'published' OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.closed_by IS DISTINCT FROM NEW.updated_by THEN
    RAISE EXCEPTION 'Closing records only the closer, the time and the reason.' USING ERRCODE = '23514';
   END IF;
   PERFORM public.schedule_entry_assert_closable(NEW);
  ELSIF OLD.governed THEN
   IF NEW.status = 'published' THEN
    RAISE EXCEPTION 'A published governed booking is immutable history; record the change on the board for independent approval, or approve a shift request.' USING ERRCODE = '23514';
   END IF;
   IF NOT EXISTS (SELECT 1 FROM public.schedule_entry_requests r WHERE r.org_id = NEW.org_id AND r.status = 'approved'
       AND r.decided_by = NEW.updated_by AND OLD.id IN (r.entry_id, r.counterpart_entry_id)) THEN
    SELECT * INTO successor FROM public.schedule_entries WHERE org_id = NEW.org_id AND supersedes_id = OLD.id AND status = 'draft' FOR SHARE;
    IF NOT FOUND THEN
     RAISE EXCEPTION 'A published governed booking is removed through an approved revision; record the removal on the board and have an independent approver publish it.' USING ERRCODE = '23514';
    END IF;
    PERFORM public.schedule_assert_independent(NEW.org_id, NEW.updated_by, ARRAY[successor.created_by, successor.updated_by],
     ARRAY[OLD.worker_party_id, successor.worker_party_id]);
   END IF;
  END IF;
 ELSE
  RAISE EXCEPTION 'Cancelled bookings are history; create a new booking.' USING ERRCODE = '23514';
 END IF;

 IF NEW.status IN ('draft','published') AND (TG_OP = 'INSERT' OR OLD.status = 'draft') AND NOT NEW.removes_predecessor THEN
  IF board.row_kind = 'people' THEN
   IF NEW.worker_party_id IS NULL THEN RAISE EXCEPTION 'People boards book active employees.' USING ERRCODE = '23514'; END IF;
   PERFORM public.schedule_entry_assert_worker(NEW.org_id, NEW.worker_party_id, NEW.employment_id, NEW.starts_on, last_date);
  ELSIF board.resource_kind = 'equipment' THEN
   IF NEW.equipment_unit_id IS NULL THEN RAISE EXCEPTION 'This board books native equipment units.' USING ERRCODE = '23514'; END IF;
   PERFORM 1 FROM public.equipment_units u WHERE u.org_id = NEW.org_id AND u.id = NEW.equipment_unit_id
     AND u.status = 'active' AND (u.in_service_on IS NULL OR u.in_service_on <= NEW.starts_on) FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active equipment unit in service on the booking date.' USING ERRCODE = '23514'; END IF;
  ELSIF board.resource_kind = 'location' THEN
   IF NEW.resource_location_id IS NULL THEN RAISE EXCEPTION 'This board books native locations.' USING ERRCODE = '23514'; END IF;
   PERFORM 1 FROM public.locations l WHERE l.org_id = NEW.org_id AND l.id = NEW.resource_location_id AND l.is_active FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active location.' USING ERRCODE = '23514'; END IF;
  ELSE RAISE EXCEPTION 'Choose the resource kind in board settings.' USING ERRCODE = '23514';
  END IF;
  IF NEW.worker_party_id IS NULL AND coalesce(array_length(NEW.required_qualification_type_ids, 1), 0) > 0 THEN
   RAISE EXCEPTION 'Qualification requirements apply to people bookings.' USING ERRCODE = '23514';
  END IF;
 END IF;
 IF NEW.worker_party_id IS NOT NULL AND NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
  PERFORM public.schedule_entry_assert_available(NEW);
  PERFORM public.schedule_entry_assert_qualified(NEW);
 END IF;
 RETURN NEW;
END $function$;

-- Whole-day bookings need authoritative day hours; removal revisions copy
-- the booking they remove and add no new working day.
CREATE OR REPLACE FUNCTION public.schedule_entries_known_day_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NEW.removes_predecessor THEN RETURN NEW; END IF;
 IF NEW.span_mode='day' AND NEW.status <> 'cancelled'
  AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status
    OR ROW(OLD.board_id,OLD.span_mode,OLD.starts_at,OLD.ends_at,OLD.break_minutes,OLD.time_zone)
     IS DISTINCT FROM ROW(NEW.board_id,NEW.span_mode,NEW.starts_at,NEW.ends_at,NEW.break_minutes,NEW.time_zone))
  AND NEW.closed_at IS NULL
  AND EXISTS(SELECT 1 FROM public.schedule_boards WHERE org_id=NEW.org_id AND id=NEW.board_id AND NOT day_policy_known) THEN
  RAISE EXCEPTION 'The board has no authoritative working-day hours; configure its start, end and break in Board Settings before booking a whole day.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;

-- Roster records: patterns, assignments, exceptions and shift requests.
CREATE FUNCTION public.schedule_roster_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE entry_row public.schedule_entries; counterpart_row public.schedule_entries; board public.schedule_boards;
 pattern_row public.schedule_patterns; author_party uuid; allowed text[];
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Roster history cannot be deleted; deactivate a pattern, end an assignment, revoke an exception or withdraw a request.' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME <> 'schedule_pattern_exceptions' THEN
  IF ROW(NEW.id, NEW.org_id, NEW.created_at, NEW.created_by) IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.created_at, OLD.created_by) THEN
   RAISE EXCEPTION 'Roster creation evidence is immutable; create a new record.' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
   RAISE EXCEPTION 'The roster record changed since it was loaded; reload it and try again.' USING ERRCODE = '40001';
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'schedule_patterns' THEN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
   RAISE EXCEPTION 'The pattern time zone is unknown; select a named time zone such as America/Toronto.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.code, NEW.subsidiary_id) IS DISTINCT FROM ROW(OLD.code, OLD.subsidiary_id) THEN
   RAISE EXCEPTION 'A pattern keeps its code and legal entity; create a new pattern instead.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_pattern_assignments' THEN
  SELECT * INTO board FROM public.schedule_boards WHERE org_id = NEW.org_id AND id = NEW.board_id FOR SHARE;
  SELECT * INTO pattern_row FROM public.schedule_patterns WHERE org_id = NEW.org_id AND id = NEW.pattern_id FOR SHARE;
  IF TG_OP = 'INSERT' THEN
   IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'patterns') OR NOT board.is_active OR NEW.status <> 'active' THEN
    RAISE EXCEPTION 'Assign recurring patterns on an active shift roster board.' USING ERRCODE = '23514';
   END IF;
   IF NOT pattern_row.is_active THEN
    RAISE EXCEPTION 'The pattern is inactive; reactivate it in Setup before assigning it.' USING ERRCODE = '23514';
   END IF;
   IF pattern_row.subsidiary_id IS NOT NULL AND NEW.subsidiary_id IS DISTINCT FROM pattern_row.subsidiary_id THEN
    RAISE EXCEPTION 'The pattern belongs to another legal entity; choose a pattern of the person''s legal entity.' USING ERRCODE = '23514';
   END IF;
   IF NEW.employment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.worker_employments e WHERE e.org_id = NEW.org_id
      AND e.id = NEW.employment_id AND e.worker_party_id = NEW.worker_party_id) THEN
    RAISE EXCEPTION 'The employment does not belong to this person; select the person again.' USING ERRCODE = '23514';
   END IF;
   IF NEW.generated_through IS NOT NULL THEN
    RAISE EXCEPTION 'A new assignment has not generated bookings yet.' USING ERRCODE = '23514';
   END IF;
  ELSE
   allowed := ARRAY['status','effective_to','generated_through','last_generation','reason','revision','updated_at','updated_by'];
   IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'An assignment keeps its board, pattern, person and start; end it and create a new assignment.' USING ERRCODE = '23514';
   END IF;
   IF OLD.status <> 'active' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
    RAISE EXCEPTION 'An ended or cancelled assignment is history; create a new assignment.' USING ERRCODE = '23514';
   END IF;
   IF OLD.status = 'active' AND NEW.status = 'active' AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'End the assignment to change its end date.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = 'ended' AND OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to THEN
    RAISE EXCEPTION 'An assignment can end earlier than planned, never later; create a new assignment to extend it.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = 'cancelled' AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'Cancelling keeps the assignment''s dates.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_pattern_exceptions' THEN
  IF TG_OP = 'UPDATE' THEN
   IF to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','revoke_reason'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','revoke_reason']
      OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'A pattern exception is revoked once with its actor and reason; record a new exception instead.' USING ERRCODE = '23514';
   END IF;
  ELSIF NEW.revoked_at IS NOT NULL THEN
   RAISE EXCEPTION 'A new pattern exception is active.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_entry_requests' THEN
  SELECT * INTO entry_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.entry_id FOR SHARE;
  IF NEW.counterpart_entry_id IS NOT NULL THEN
   SELECT * INTO counterpart_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.counterpart_entry_id FOR SHARE;
  END IF;
  IF TG_OP = 'INSERT' THEN
   SELECT party_id INTO author_party FROM public.users WHERE org_id = NEW.org_id AND id = NEW.created_by AND is_active FOR SHARE;
   IF author_party IS NULL OR author_party <> NEW.worker_party_id THEN
    RAISE EXCEPTION 'A shift request is made by the scheduled person from their own schedule.' USING ERRCODE = '23514';
   END IF;
   IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'shift_requests') THEN
    RAISE EXCEPTION 'Shift requests are made for shifts on shift roster boards; ask the scheduler to change this booking.' USING ERRCODE = '23514';
   END IF;
   IF entry_row.status <> 'published' OR entry_row.closed_at IS NOT NULL OR entry_row.revision <> NEW.entry_revision
      OR entry_row.worker_party_id IS DISTINCT FROM NEW.worker_party_id OR entry_row.board_id <> NEW.board_id OR entry_row.starts_at <= now() THEN
    RAISE EXCEPTION 'A shift request names a current published future booking of the requester; reload the schedule.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status <> (CASE WHEN NEW.kind = 'swap' THEN 'awaiting_counterpart' ELSE 'pending' END)
      OR NEW.decided_by IS NOT NULL OR NEW.counterpart_responded_by IS NOT NULL THEN
    RAISE EXCEPTION 'A new swap awaits the colleague''s answer; other requests await a decision.' USING ERRCODE = '23514';
   END IF;
   IF NEW.kind = 'swap' AND (counterpart_row.status <> 'published' OR counterpart_row.closed_at IS NOT NULL OR counterpart_row.revision <> NEW.counterpart_entry_revision
      OR counterpart_row.worker_party_id IS DISTINCT FROM NEW.counterpart_party_id OR counterpart_row.board_id <> NEW.board_id OR counterpart_row.starts_at <= now()) THEN
    RAISE EXCEPTION 'A swap names a colleague''s current published future booking on the same board; reload the schedule.' USING ERRCODE = '23514';
   END IF;
  ELSE
   allowed := ARRAY['status','counterpart_responded_by','counterpart_responded_at','flow_run_id','decided_by','decided_at','decision_reason','revision','updated_at','updated_by'];
   IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'Shift request details are immutable; withdraw it and make a new request.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = OLD.status THEN
    IF ROW(NEW.counterpart_responded_by, NEW.decided_by) IS DISTINCT FROM ROW(OLD.counterpart_responded_by, OLD.decided_by)
       OR (OLD.flow_run_id IS NOT NULL AND NEW.flow_run_id IS DISTINCT FROM OLD.flow_run_id) THEN
     RAISE EXCEPTION 'Shift request evidence is immutable.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'awaiting_counterpart' AND NEW.status IN ('pending','declined') AND NEW.updated_by <> OLD.created_by THEN
    SELECT party_id INTO author_party FROM public.users WHERE org_id = NEW.org_id AND id = NEW.updated_by AND is_active FOR SHARE;
    IF author_party IS DISTINCT FROM NEW.counterpart_party_id THEN
     RAISE EXCEPTION 'Only the colleague named in a swap can accept or decline it.' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'pending' AND (NEW.counterpart_responded_by IS DISTINCT FROM NEW.updated_by OR NEW.decided_by IS NOT NULL) THEN
     RAISE EXCEPTION 'Accepting a swap records the colleague''s answer and awaits a decision.' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'declined' AND NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN
     RAISE EXCEPTION 'Declining a swap records the colleague as the decider.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status IN ('awaiting_counterpart','pending') AND NEW.status = 'withdrawn' THEN
    IF NEW.updated_by <> OLD.created_by OR NEW.decided_by IS NOT NULL THEN
     RAISE EXCEPTION 'Only the request author can withdraw it; a decider declines it instead.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'pending' AND NEW.status IN ('approved','declined') THEN
    IF NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN
     RAISE EXCEPTION 'Decision evidence must name the decider.' USING ERRCODE = '23514';
    END IF;
    PERFORM public.schedule_assert_independent(NEW.org_id, NEW.decided_by, ARRAY[OLD.created_by, coalesce(OLD.counterpart_responded_by, OLD.created_by)],
     ARRAY[OLD.worker_party_id, coalesce(OLD.counterpart_party_id, OLD.worker_party_id)]);
    IF NEW.status = 'approved' AND (entry_row.status <> 'published' OR entry_row.revision <> OLD.entry_revision
       OR (OLD.kind = 'swap' AND (counterpart_row.status <> 'published' OR counterpart_row.revision <> OLD.counterpart_entry_revision))) THEN
     RAISE EXCEPTION 'The booking changed after the request was made; decline this request and ask for a new one.' USING ERRCODE = '23514';
    END IF;
   ELSE
    RAISE EXCEPTION 'This shift request transition is unavailable; reload the request.' USING ERRCODE = '23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;

-- An approved request has its complete outcome when the command commits.
CREATE FUNCTION public.schedule_entry_requests_outcome_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE request_row public.schedule_entry_requests; entry_row public.schedule_entries; counterpart_row public.schedule_entries;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 SELECT * INTO request_row FROM public.schedule_entry_requests WHERE org_id = NEW.org_id AND id = NEW.id;
 IF request_row.status <> 'approved' THEN RETURN NULL; END IF;
 SELECT * INTO entry_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = request_row.entry_id;
 IF entry_row.status <> 'cancelled' THEN
  RAISE EXCEPTION 'An approved shift request replaces or releases its booking in the same command.' USING ERRCODE = '23514';
 END IF;
 IF request_row.kind = 'change' AND NOT EXISTS (SELECT 1 FROM public.schedule_entries s WHERE s.org_id = NEW.org_id
    AND s.origin_request_id = request_row.id AND s.supersedes_id = request_row.entry_id AND s.status = 'published'
    AND s.starts_at = request_row.proposed_starts_at AND s.ends_at = request_row.proposed_ends_at
    AND s.break_minutes = request_row.proposed_break_minutes AND s.worker_party_id = request_row.worker_party_id) THEN
  RAISE EXCEPTION 'An approved change publishes the requested times in the same command.' USING ERRCODE = '23514';
 END IF;
 IF request_row.kind = 'swap' THEN
  SELECT * INTO counterpart_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = request_row.counterpart_entry_id;
  IF counterpart_row.status <> 'cancelled'
     OR NOT EXISTS (SELECT 1 FROM public.schedule_entries s WHERE s.org_id = NEW.org_id AND s.origin_request_id = request_row.id
       AND s.supersedes_id = request_row.entry_id AND s.status = 'published' AND s.worker_party_id = request_row.counterpart_party_id
       AND s.starts_at = entry_row.starts_at AND s.ends_at = entry_row.ends_at)
     OR NOT EXISTS (SELECT 1 FROM public.schedule_entries s WHERE s.org_id = NEW.org_id AND s.origin_request_id = request_row.id
       AND s.supersedes_id = request_row.counterpart_entry_id AND s.status = 'published' AND s.worker_party_id = request_row.worker_party_id
       AND s.starts_at = counterpart_row.starts_at AND s.ends_at = counterpart_row.ends_at) THEN
   RAISE EXCEPTION 'An approved swap exchanges both bookings in the same command.' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NULL;
END $function$;

-- Attendance evidence: devices and mappings are effective-dated; source
-- events, batches, policies and observations are immutable.
CREATE FUNCTION public.schedule_attendance_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE device_row public.schedule_attendance_devices; identity_row public.schedule_attendance_identities;
 batch_row public.schedule_attendance_batches; event_row public.schedule_attendance_events; entry_row public.schedule_entries;
 observation_row public.schedule_attendance_observations; claim_row public.schedule_attendance_event_claims;
 policy_row public.schedule_attendance_policies; prior_through timestamptz;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Attendance history cannot be deleted; end a mapping, deactivate a device or append a reasoned correction.' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' THEN
  IF TG_TABLE_NAME IN ('schedule_attendance_devices','schedule_attendance_identities','schedule_attendance_watermarks') THEN
   IF ROW(NEW.id, NEW.org_id, NEW.created_at, NEW.created_by) IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'Attendance creation evidence is immutable; create a new record.' USING ERRCODE = '23514';
   END IF;
   IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'The attendance record changed since it was loaded; reload it and try again.' USING ERRCODE = '40001';
   END IF;
  ELSIF TG_TABLE_NAME <> 'schedule_attendance_event_claims' THEN
   RAISE EXCEPTION 'Attendance source and observation evidence is immutable; append a reasoned correction with the previous record as its predecessor.' USING ERRCODE = '23514';
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'schedule_attendance_devices' THEN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
   RAISE EXCEPTION 'The device time zone is unknown; select its named source time zone.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) - ARRAY['name','is_active','reason','revision','updated_at','updated_by']
     IS DISTINCT FROM to_jsonb(OLD) - ARRAY['name','is_active','reason','revision','updated_at','updated_by'] THEN
   RAISE EXCEPTION 'A device keeps its code, legal entity and time zone; register a new device for a changed source.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_identities' THEN
  SELECT * INTO device_row FROM public.schedule_attendance_devices WHERE org_id = NEW.org_id AND id = NEW.device_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
   IF NOT device_row.is_active OR device_row.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id THEN
    RAISE EXCEPTION 'The device is unavailable for this legal entity; choose an active device.' USING ERRCODE = '23514';
   END IF;
   IF NEW.employment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.worker_employments e WHERE e.org_id = NEW.org_id AND e.id = NEW.employment_id
      AND e.worker_party_id = NEW.worker_party_id AND e.employer_subsidiary_id = NEW.subsidiary_id) THEN
    RAISE EXCEPTION 'The employment belongs to another person or employer; select the person''s employment with the device''s legal entity.' USING ERRCODE = '23514';
   END IF;
  ELSE
   IF to_jsonb(NEW) - ARRAY['effective_to','reason','revision','updated_at','updated_by'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['effective_to','reason','revision','updated_at','updated_by']
      OR NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to) THEN
    RAISE EXCEPTION 'A device mapping is immutable; end its window and create a new mapping.' USING ERRCODE = '23514';
   END IF;
   IF EXISTS (SELECT 1 FROM public.schedule_attendance_events WHERE org_id = NEW.org_id AND identity_id = NEW.id AND source_local_date >= NEW.effective_to) THEN
    RAISE EXCEPTION 'Recorded check-ins extend beyond this mapping end; choose a later end date.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_policies' THEN
  SELECT * INTO policy_row FROM public.schedule_attendance_policies WHERE org_id = NEW.org_id AND board_id = NEW.board_id
   AND effective_from > NEW.effective_from LIMIT 1;
  IF FOUND THEN
   RAISE EXCEPTION 'A later attendance policy version exists; add versions in date order.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schedule_attendance_observations o JOIN public.schedule_entries e ON e.org_id = o.org_id AND e.id = o.entry_id
     WHERE o.org_id = NEW.org_id AND o.board_id = NEW.board_id AND e.starts_on >= NEW.effective_from) THEN
   RAISE EXCEPTION 'Attendance was already observed on or after this date; choose a later effective date so recorded observations keep their policy.' USING ERRCODE = '23514';
  END IF;
  IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'attendance') THEN
   RAISE EXCEPTION 'Attendance policies apply to shift roster boards.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_batches' THEN
  SELECT * INTO device_row FROM public.schedule_attendance_devices WHERE org_id = NEW.org_id AND id = NEW.device_id FOR UPDATE;
  IF NOT FOUND OR NOT device_row.is_active THEN
   RAISE EXCEPTION 'The attendance device is inactive; reactivate it before importing check-ins.' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_evidence->>'source' IS NULL OR length(btrim(NEW.source_evidence->>'source')) = 0 THEN
   RAISE EXCEPTION 'Check-in batches need source evidence; identify the source connection or import file.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_events' THEN
  SELECT * INTO device_row FROM public.schedule_attendance_devices WHERE org_id = NEW.org_id AND id = NEW.device_id FOR UPDATE;
  SELECT * INTO batch_row FROM public.schedule_attendance_batches WHERE org_id = NEW.org_id AND id = NEW.batch_id;
  SELECT * INTO identity_row FROM public.schedule_attendance_identities WHERE org_id = NEW.org_id AND id = NEW.identity_id FOR SHARE;
  IF ROW(NEW.subsidiary_id, NEW.worker_party_id, NEW.employment_id) IS DISTINCT FROM ROW(identity_row.subsidiary_id, identity_row.worker_party_id, identity_row.employment_id)
     OR NEW.source_local_date <> (NEW.occurred_at AT TIME ZONE device_row.time_zone)::date
     OR NEW.source_local_date < identity_row.effective_from OR (identity_row.effective_to IS NOT NULL AND NEW.source_local_date >= identity_row.effective_to) THEN
   RAISE EXCEPTION 'The check-in does not match its dated device mapping; reconcile the source worker mapping and local date before importing.' USING ERRCODE = '23514';
  END IF;
  SELECT complete_through INTO prior_through FROM public.schedule_attendance_watermarks WHERE org_id = NEW.org_id AND device_id = NEW.device_id FOR SHARE;
  IF (NEW.occurred_at <= prior_through OR NEW.supersedes_id IS NOT NULL) AND NOT batch_row.is_correction THEN
   RAISE EXCEPTION 'This check-in changes source records already declared complete; import it in a reasoned correction batch and process attendance again.' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
   SELECT * INTO event_row FROM public.schedule_attendance_events WHERE org_id = NEW.org_id AND id = NEW.supersedes_id FOR SHARE;
   IF NEW.source_version IS DISTINCT FROM event_row.source_version + 1 OR NEW.source_event_id IS DISTINCT FROM event_row.source_event_id
      OR NEW.device_id IS DISTINCT FROM event_row.device_id THEN
    RAISE EXCEPTION 'The correction does not name the next source version; append it to the latest version of the same source event.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_watermarks' THEN
  SELECT * INTO device_row FROM public.schedule_attendance_devices WHERE org_id = NEW.org_id AND id = NEW.device_id FOR UPDATE;
  SELECT * INTO batch_row FROM public.schedule_attendance_batches WHERE org_id = NEW.org_id AND id = NEW.batch_id;
  IF NEW.complete_through IS DISTINCT FROM batch_row.complete_through THEN
   RAISE EXCEPTION 'The completeness watermark must equal its batch''s declared completeness.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.complete_through < OLD.complete_through) THEN
   RAISE EXCEPTION 'Device completeness never moves backwards; import a reasoned correction batch instead.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_observations' THEN
  SELECT * INTO entry_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.entry_id FOR UPDATE;
  IF entry_row.status NOT IN ('published','cancelled') OR entry_row.worker_party_id IS NULL
     OR ROW(NEW.board_id, NEW.worker_party_id, NEW.employment_id, NEW.subsidiary_id)
      IS DISTINCT FROM ROW(entry_row.board_id, entry_row.worker_party_id, entry_row.employment_id, entry_row.subsidiary_id) THEN
   RAISE EXCEPTION 'Attendance is observed for a person''s published booking and its exact subject; reload the board.' USING ERRCODE = '23514';
  END IF;
  IF (entry_row.status = 'cancelled') <> (NEW.status = 'voided') THEN
   RAISE EXCEPTION 'A cancelled booking records voided attendance; process its current state without deleting earlier observations.' USING ERRCODE = '23514';
  END IF;
  IF entry_row.closed_at IS NOT NULL THEN
   RAISE EXCEPTION 'A closed shift keeps its attendance; closing is final.' USING ERRCODE = '23514';
  END IF;
  IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'attendance') THEN
   RAISE EXCEPTION 'Attendance is observed for shifts on shift roster boards.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'voided' THEN
   SELECT * INTO policy_row FROM public.schedule_attendance_policies WHERE org_id = NEW.org_id AND board_id = entry_row.board_id
    AND effective_from <= entry_row.starts_on ORDER BY effective_from DESC LIMIT 1;
   IF policy_row.id IS DISTINCT FROM NEW.policy_id THEN
    RAISE EXCEPTION 'Attendance uses the board policy effective on the booking date; reload and process again.' USING ERRCODE = '23514';
   END IF;
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
   SELECT * INTO observation_row FROM public.schedule_attendance_observations WHERE org_id = NEW.org_id AND id = NEW.supersedes_id FOR SHARE;
   IF observation_row.entry_id IS DISTINCT FROM NEW.entry_id THEN
    RAISE EXCEPTION 'An attendance correction supersedes the latest observation of the same booking.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_event_claims' THEN
  SELECT * INTO event_row FROM public.schedule_attendance_events WHERE org_id = NEW.org_id AND id = NEW.event_id FOR UPDATE;
  SELECT * INTO entry_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.entry_id FOR SHARE;
  IF TG_OP = 'UPDATE' THEN
   IF to_jsonb(NEW) - ARRAY['released_at','released_by','release_reason'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['released_at','released_by','release_reason']
      OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'A check-in attribution is released once with its actor and reason.' USING ERRCODE = '23514';
   END IF;
  ELSE
   SELECT * INTO policy_row FROM public.schedule_attendance_policies WHERE org_id = NEW.org_id AND board_id = entry_row.board_id
    AND effective_from <= entry_row.starts_on ORDER BY effective_from DESC LIMIT 1;
   IF NEW.released_at IS NOT NULL OR event_row.kind = 'void' OR policy_row.id IS NULL
      OR event_row.worker_party_id IS DISTINCT FROM entry_row.worker_party_id OR entry_row.status <> 'published'
      OR EXISTS (SELECT 1 FROM public.schedule_attendance_events WHERE org_id = NEW.org_id AND supersedes_id = NEW.event_id)
      OR event_row.occurred_at < entry_row.starts_at - make_interval(mins => policy_row.capture_before_minutes)
      OR event_row.occurred_at > entry_row.ends_at + make_interval(mins => policy_row.capture_after_minutes) THEN
    RAISE EXCEPTION 'The check-in cannot be attributed to this booking; reconcile its current source version, person and capture window.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_observation_events' THEN
  SELECT * INTO observation_row FROM public.schedule_attendance_observations WHERE org_id = NEW.org_id AND id = NEW.observation_id FOR SHARE;
  SELECT * INTO claim_row FROM public.schedule_attendance_event_claims WHERE org_id = NEW.org_id AND id = NEW.event_claim_id FOR SHARE;
  IF claim_row.entry_id IS DISTINCT FROM observation_row.entry_id OR claim_row.released_at IS NOT NULL OR NEW.created_by IS DISTINCT FROM observation_row.created_by THEN
   RAISE EXCEPTION 'Observation evidence must match its active booking attribution; process the booking''s check-ins together.' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NEW;
END $function$;

-- Batches, corrections and observations are validated once every row of
-- the command exists.
CREATE FUNCTION public.schedule_attendance_evidence_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE batch_row public.schedule_attendance_batches; observation_row public.schedule_attendance_observations;
 entry_row public.schedule_entries; policy_row public.schedule_attendance_policies; event_row record;
 device_count integer; incomplete_count integer; effective_through timestamptz; capture_from timestamptz; capture_to timestamptz;
 expected_ids uuid[]; linked_ids uuid[]; state text := 'out'; opened_at timestamptz; break_at timestamptz;
 first_at timestamptz; last_at timestamptz; previous_at timestamptz; presence bigint := 0; breaks bigint := 0;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME = 'schedule_attendance_batches' THEN
  SELECT * INTO batch_row FROM public.schedule_attendance_batches WHERE org_id = NEW.org_id AND id = NEW.id;
  IF batch_row.event_count <> (SELECT count(*) FROM public.schedule_attendance_events WHERE org_id = NEW.org_id AND batch_id = NEW.id) THEN
   RAISE EXCEPTION 'The check-in batch is incomplete; import every declared event and its completeness in one command.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_events' THEN
  IF NEW.supersedes_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.schedule_attendance_event_claims WHERE org_id = NEW.org_id
     AND event_id = NEW.supersedes_id AND released_at IS NULL) THEN
   RAISE EXCEPTION 'The corrected check-in is still attributed to a booking; release its attribution with the correction and process attendance again.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_attendance_observations' THEN
  SELECT * INTO observation_row FROM public.schedule_attendance_observations WHERE org_id = NEW.org_id AND id = NEW.id;
  IF observation_row.status = 'voided' THEN RETURN NULL; END IF;
  SELECT * INTO entry_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = observation_row.entry_id;
  SELECT * INTO policy_row FROM public.schedule_attendance_policies WHERE org_id = NEW.org_id AND id = observation_row.policy_id;
  capture_from := entry_row.starts_at - make_interval(mins => policy_row.capture_before_minutes);
  capture_to := entry_row.ends_at + make_interval(mins => policy_row.capture_after_minutes);
  IF EXISTS (SELECT 1 FROM public.schedule_attendance_identities i JOIN public.schedule_attendance_devices d ON d.org_id = i.org_id AND d.id = i.device_id
    WHERE i.org_id = NEW.org_id AND i.worker_party_id = entry_row.worker_party_id
     AND daterange(i.effective_from, i.effective_to, '[)') && daterange((capture_from AT TIME ZONE d.time_zone)::date, (capture_to AT TIME ZONE d.time_zone)::date, '[]')
     AND NOT daterange(i.effective_from, i.effective_to, '[)') @> daterange((capture_from AT TIME ZONE d.time_zone)::date, (capture_to AT TIME ZONE d.time_zone)::date, '[]')) THEN
   RAISE EXCEPTION 'A device mapping changes inside the booking''s capture window; reconcile the dated mapping before processing attendance.' USING ERRCODE = '23514';
  END IF;
  SELECT count(DISTINCT i.device_id), count(*) FILTER (WHERE w.complete_through IS NULL), min(w.complete_through)
   INTO device_count, incomplete_count, effective_through
   FROM public.schedule_attendance_identities i JOIN public.schedule_attendance_devices d ON d.org_id = i.org_id AND d.id = i.device_id
   LEFT JOIN public.schedule_attendance_watermarks w ON w.org_id = i.org_id AND w.device_id = i.device_id
   WHERE i.org_id = NEW.org_id AND i.worker_party_id = entry_row.worker_party_id
    AND i.effective_from <= (capture_from AT TIME ZONE d.time_zone)::date AND (i.effective_to IS NULL OR i.effective_to > (capture_to AT TIME ZONE d.time_zone)::date);
  IF device_count = 0 THEN
   RAISE EXCEPTION 'No dated device mapping covers this booking''s capture window; map the person''s device identifier before processing attendance.' USING ERRCODE = '23514';
  END IF;
  IF incomplete_count > 0 THEN effective_through := NULL; END IF;
  IF observation_row.complete_through IS DISTINCT FROM effective_through THEN
   RAISE EXCEPTION 'Device completeness changed; reload and process attendance again.' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(array_agg(e.id ORDER BY e.id), ARRAY[]::uuid[]) INTO expected_ids FROM public.schedule_attendance_events e
   WHERE e.org_id = NEW.org_id AND e.worker_party_id = entry_row.worker_party_id AND e.occurred_at BETWEEN capture_from AND capture_to AND e.kind <> 'void'
    AND NOT EXISTS (SELECT 1 FROM public.schedule_attendance_events n WHERE n.org_id = e.org_id AND n.supersedes_id = e.id);
  SELECT coalesce(array_agg(c.event_id ORDER BY c.event_id), ARRAY[]::uuid[]) INTO linked_ids FROM public.schedule_attendance_observation_events oe
   JOIN public.schedule_attendance_event_claims c ON c.org_id = oe.org_id AND c.id = oe.event_claim_id
   WHERE oe.org_id = NEW.org_id AND oe.observation_id = NEW.id AND c.released_at IS NULL;
  IF expected_ids IS DISTINCT FROM linked_ids THEN
   RAISE EXCEPTION 'Attendance must retain every current check-in in the capture window; reconcile overlapping attribution and process the complete source set.' USING ERRCODE = '23514';
  END IF;
  IF effective_through IS NULL OR effective_through < capture_to THEN
   IF observation_row.status <> 'waiting_for_sync' THEN
    RAISE EXCEPTION 'The mapped devices have not declared the capture window complete; wait for synchronization before finalizing attendance.' USING ERRCODE = '23514';
   END IF;
   RETURN NULL;
  END IF;
  IF cardinality(expected_ids) = 0 THEN
   IF observation_row.status <> 'absent' THEN
    RAISE EXCEPTION 'Complete sources hold no check-ins for this booking; record the absence without a presence interval.' USING ERRCODE = '23514';
   END IF;
   RETURN NULL;
  END IF;
  FOR event_row IN SELECT id, kind, occurred_at FROM public.schedule_attendance_events WHERE org_id = NEW.org_id AND id = ANY (expected_ids) ORDER BY occurred_at, id LOOP
   IF previous_at IS NOT NULL AND event_row.occurred_at <= previous_at THEN
    RAISE EXCEPTION 'Check-ins have indistinguishable times; reconcile the source instants before processing attendance.' USING ERRCODE = '23514';
   END IF;
   IF state = 'out' AND event_row.kind = 'clock_in' THEN opened_at := event_row.occurred_at; first_at := coalesce(first_at, event_row.occurred_at); state := 'in';
   ELSIF state = 'in' AND event_row.kind = 'break_start' THEN break_at := event_row.occurred_at; state := 'break';
   ELSIF state = 'break' AND event_row.kind = 'break_end' THEN breaks := breaks + (extract(epoch FROM event_row.occurred_at - break_at) * 1000)::bigint; state := 'in';
   ELSIF state = 'in' AND event_row.kind = 'clock_out' THEN presence := presence + (extract(epoch FROM event_row.occurred_at - opened_at) * 1000)::bigint; last_at := event_row.occurred_at; state := 'out';
   ELSE
    RAISE EXCEPTION 'Finalized check-ins contain an inconsistent clock pair; reconcile the missing or contradictory source event.' USING ERRCODE = '23514';
   END IF;
   previous_at := event_row.occurred_at;
  END LOOP;
  IF state <> 'out' THEN
   RAISE EXCEPTION 'Finalized check-ins leave an unfinished clock or break; reconcile the missing source event.' USING ERRCODE = '23514';
  END IF;
  IF observation_row.status <> 'present' OR observation_row.first_in IS DISTINCT FROM first_at OR observation_row.last_out IS DISTINCT FROM last_at
     OR observation_row.presence_milliseconds IS DISTINCT FROM presence - breaks OR observation_row.break_milliseconds IS DISTINCT FROM breaks
     OR observation_row.late IS DISTINCT FROM (first_at > entry_row.starts_at + make_interval(mins => policy_row.late_grace_minutes))
     OR observation_row.left_early IS DISTINCT FROM (last_at < entry_row.ends_at - make_interval(mins => policy_row.early_grace_minutes))
     OR observation_row.over_break IS DISTINCT FROM (breaks > (entry_row.break_minutes + policy_row.break_grace_minutes)::bigint * 60000) THEN
   RAISE EXCEPTION 'Attendance differs from its clock and break evidence; process the source sequence again.' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NULL;
END $function$;

CREATE FUNCTION public.schedule_roster_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id, table_name, row_id, action, actor_id, changes)
 VALUES (NEW.org_id, TG_TABLE_NAME, NEW.id, lower(TG_OP),
  CASE WHEN public.openbooks_clone_authority() THEN NULL
   ELSE coalesce(to_jsonb(NEW)->>'revoked_by', to_jsonb(NEW)->>'released_by', to_jsonb(NEW)->>'updated_by', to_jsonb(NEW)->>'created_by')::uuid END,
  jsonb_build_object('before', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END, 'after', to_jsonb(NEW),
   'reason', CASE WHEN public.openbooks_clone_authority() THEN 'Preserve scheduling evidence during controlled sandbox cloning.'
    ELSE coalesce(to_jsonb(NEW)->>'revoke_reason', to_jsonb(NEW)->>'release_reason', to_jsonb(NEW)->>'decision_reason', to_jsonb(NEW)->>'reason') END));
 RETURN NEW;
END $function$;

DO $block$ DECLARE target record; BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('schedule_patterns','schedule_roster_guard'),
  ('schedule_pattern_assignments','schedule_roster_guard'),
  ('schedule_pattern_exceptions','schedule_roster_guard'),
  ('schedule_entry_requests','schedule_roster_guard'),
  ('schedule_attendance_devices','schedule_attendance_guard'),
  ('schedule_attendance_identities','schedule_attendance_guard'),
  ('schedule_attendance_policies','schedule_attendance_guard'),
  ('schedule_attendance_batches','schedule_attendance_guard'),
  ('schedule_attendance_events','schedule_attendance_guard'),
  ('schedule_attendance_watermarks','schedule_attendance_guard'),
  ('schedule_attendance_observations','schedule_attendance_guard'),
  ('schedule_attendance_event_claims','schedule_attendance_guard'),
  ('schedule_attendance_observation_events','schedule_attendance_guard')
 ) AS expected(table_name, guard) LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', target.guard, target.table_name, target.guard);
  EXECUTE format('CREATE TRIGGER schedule_roster_audit AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.schedule_roster_audit()', target.table_name);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true))) WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true)))', target.table_name);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''', target.table_name);
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', target.table_name);
 END LOOP;
 FOREACH target.table_name IN ARRAY ARRAY['schedule_attendance_batches','schedule_attendance_events','schedule_attendance_observations'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER schedule_attendance_evidence_guard AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.schedule_attendance_evidence_guard()', target.table_name);
 END LOOP;
END $block$;
CREATE CONSTRAINT TRIGGER schedule_entry_requests_outcome_guard AFTER INSERT OR UPDATE ON public.schedule_entry_requests
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.schedule_entry_requests_outcome_guard();

COMMENT ON TABLE public.schedule_attendance_batches IS
 'Admitted check-in source batches with their source evidence, novel event count and declared completeness. Source evidence, so the table stays out of the governed-query catalog.';
COMMENT ON TABLE public.schedule_attendance_events IS
 'Immutable source check-ins mapped to a dated device identity; corrections append the next source version. Source evidence, so the table stays out of the governed-query catalog.';
COMMENT ON TABLE public.schedule_attendance_watermarks IS
 'The latest declared completeness of each device; it never moves backwards. Synchronization state, so the table stays out of the governed-query catalog.';
COMMENT ON TABLE public.schedule_attendance_observations IS
 'Immutable attendance observations of published bookings under the effective board policy: waiting for synchronization, absent, present (late, left early, over break) or voided. Corrections supersede the latest observation.';
COMMENT ON TABLE public.schedule_attendance_event_claims IS
 'Attribution of a check-in to one booking, released once with its actor and reason. Evidence plumbing, so the table stays out of the governed-query catalog.';
COMMENT ON TABLE public.schedule_attendance_observation_events IS
 'The attributed check-ins an observation used. Evidence plumbing, so the table stays out of the governed-query catalog.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('schedule_patterns', '0737_unified_scheduling_patterns_requests_attendance'),
 ('schedule_pattern_assignments', '0737_unified_scheduling_patterns_requests_attendance'),
 ('schedule_pattern_exceptions', '0737_unified_scheduling_patterns_requests_attendance'),
 ('schedule_entry_requests', '0737_unified_scheduling_patterns_requests_attendance'),
 ('schedule_attendance_devices', '0737_unified_scheduling_patterns_requests_attendance'),
 ('schedule_attendance_identities', '0737_unified_scheduling_patterns_requests_attendance'),
 ('schedule_attendance_policies', '0737_unified_scheduling_patterns_requests_attendance'),
 ('schedule_attendance_observations', '0737_unified_scheduling_patterns_requests_attendance')
ON CONFLICT (relation) DO NOTHING; -- expected on replay; the registry seed is idempotent

SELECT public.openbooks_refresh_query_catalog();
