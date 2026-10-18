-- Governed publication and shift requests route through optional Flows.
--
-- Approval is never built into scheduling. Publishing a governed shift
-- roster board records a publication of the board's unpublished changes and
-- submits it to any enabled Schedule publication Flow; an employee's shift
-- request is submitted to any enabled Shift request Flow. When a Flow raises
-- an approval gate, the publication or request waits for the gate's decision
-- and is applied by the deciding approver. When no Flow gates it, it is
-- released at once by its submitter and records that no approval applied.
-- Who may decide a gate, including separation from the submitter, is the
-- Flow's policy.
--
-- A published governed booking stays immutable history: it changes only
-- through a published revision or an approved shift request.
--
-- Backfill: none. Existing shift requests keep their recorded decisions.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.schedule_entry_requests
 ADD COLUMN released_without_approval boolean NOT NULL DEFAULT false,
 DROP CONSTRAINT schedule_entry_requests_decision,
 ADD CONSTRAINT schedule_entry_requests_decision CHECK (
  (decided_by IS NULL OR decided_at IS NOT NULL)
  AND ((status IN ('approved','declined')) = (decided_at IS NOT NULL AND decision_reason IS NOT NULL))
  AND (status NOT IN ('approved','declined') OR decided_by IS NOT NULL OR released_without_approval)
  AND (NOT released_without_approval OR (status = 'approved' AND decided_by IS NULL AND flow_run_id IS NULL)));
COMMENT ON COLUMN public.schedule_entry_requests.released_without_approval IS
 'True when no approval Flow gated the request, so it was applied when submitted; decided_by is then empty.';

CREATE TABLE public.schedule_publications (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 board_id uuid NOT NULL,
 subsidiary_id uuid,
 from_date date NOT NULL CHECK (from_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 through_date date NOT NULL CHECK (through_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 entry_ids uuid[] NOT NULL,
 entry_revisions integer[] NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','withdrawn')),
 flow_run_id uuid,
 released_without_approval boolean NOT NULL DEFAULT false,
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
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, decided_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_publications_window CHECK (through_date >= from_date AND through_date - from_date <= 366),
 CONSTRAINT schedule_publications_entries CHECK (coalesce(array_ndims(entry_ids), 1) = 1 AND cardinality(entry_ids) BETWEEN 1 AND 5000
  AND cardinality(entry_revisions) = cardinality(entry_ids)),
 CONSTRAINT schedule_publications_decision CHECK (
  (decided_by IS NULL OR decided_at IS NOT NULL)
  AND ((status IN ('approved','declined')) = (decided_at IS NOT NULL AND decision_reason IS NOT NULL))
  AND (status NOT IN ('approved','declined') OR decided_by IS NOT NULL OR released_without_approval)
  AND (NOT released_without_approval OR (status = 'approved' AND decided_by IS NULL AND flow_run_id IS NULL)))
);
CREATE UNIQUE INDEX schedule_publications_pending ON public.schedule_publications(org_id, board_id) WHERE status = 'pending';
CREATE INDEX schedule_publications_board ON public.schedule_publications(org_id, board_id, created_at);
CREATE INDEX schedule_publications_entries ON public.schedule_publications USING gin (entry_ids);
COMMENT ON TABLE public.schedule_publications IS
 'Publications of a governed shift roster board''s unpublished changes: the changes submitted with their revisions, the optional approval Flow run, and the decision or the record that no approval applied.';

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
       OR coalesce(request_row.decided_by, request_row.updated_by) IS DISTINCT FROM NEW.published_by OR NEW.published_by IS DISTINCT FROM NEW.created_by
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
  -- A draft awaiting a publication decision keeps the content being decided.
  IF EXISTS (SELECT 1 FROM public.schedule_publications p WHERE p.org_id = NEW.org_id AND p.board_id = NEW.board_id
      AND p.status = 'pending' AND OLD.id = ANY (p.entry_ids)) THEN
   RAISE EXCEPTION 'This change is awaiting its publication decision; wait for the decision or have the publication declined.' USING ERRCODE = '23514';
  END IF;
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
   IF NEW.governed AND NOT EXISTS (SELECT 1 FROM public.schedule_publications p WHERE p.org_id = NEW.org_id AND p.board_id = NEW.board_id
      AND p.status = 'approved' AND NEW.id = ANY (p.entry_ids) AND coalesce(p.decided_by, p.updated_by) = NEW.published_by) THEN
    RAISE EXCEPTION 'A governed booking is published through its board''s publication, which routes through any configured approval Flow; publish the board.' USING ERRCODE = '23514';
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
    RAISE EXCEPTION 'A published governed booking is immutable history; record the change on the board and publish it, or approve a shift request.' USING ERRCODE = '23514';
   END IF;
   IF NOT EXISTS (SELECT 1 FROM public.schedule_entry_requests r WHERE r.org_id = NEW.org_id AND r.status = 'approved'
       AND coalesce(r.decided_by, r.updated_by) = NEW.updated_by AND OLD.id IN (r.entry_id, r.counterpart_entry_id)) THEN
    SELECT * INTO successor FROM public.schedule_entries WHERE org_id = NEW.org_id AND supersedes_id = OLD.id AND status = 'draft' FOR SHARE;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.schedule_publications p WHERE p.org_id = NEW.org_id AND p.board_id = NEW.board_id
       AND p.status = 'approved' AND successor.id = ANY (p.entry_ids) AND coalesce(p.decided_by, p.updated_by) = NEW.updated_by) THEN
     RAISE EXCEPTION 'A published governed booking is changed or removed through a published revision; record the change on the board and publish it.' USING ERRCODE = '23514';
    END IF;
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

CREATE OR REPLACE FUNCTION public.schedule_roster_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE entry_row public.schedule_entries; counterpart_row public.schedule_entries; board public.schedule_boards;
 pattern_row public.schedule_patterns; author_party uuid; allowed text[]; listed integer;
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
 IF TG_TABLE_NAME = 'schedule_publications' THEN
  SELECT * INTO board FROM public.schedule_boards WHERE org_id = NEW.org_id AND id = NEW.board_id FOR SHARE;
  IF TG_OP = 'INSERT' THEN
   IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'governed_publication') OR board.publish_policy <> 'governed' THEN
    RAISE EXCEPTION 'Publications are recorded for governed shift roster boards.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.released_without_approval OR NEW.flow_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'A new publication awaits its decision.' USING ERRCODE = '23514';
   END IF;
   SELECT count(*) INTO listed FROM public.schedule_entries x WHERE x.org_id = NEW.org_id AND x.board_id = NEW.board_id AND x.status = 'draft'
    AND x.id = ANY (NEW.entry_ids);
   IF listed <> cardinality(NEW.entry_ids) THEN
    RAISE EXCEPTION 'A publication names the board''s unpublished changes; reload the board.' USING ERRCODE = '23514';
   END IF;
  ELSE
   allowed := ARRAY['status','flow_run_id','released_without_approval','decided_by','decided_at','decision_reason','revision','updated_at','updated_by'];
   IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'A publication keeps the changes it was submitted with; submit a new publication.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = OLD.status THEN
    IF NEW.status <> 'pending' OR OLD.flow_run_id IS NOT NULL OR NEW.decided_by IS NOT NULL OR NEW.released_without_approval THEN
     RAISE EXCEPTION 'Publication evidence is immutable.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    IF NOT ((NEW.decided_by = NEW.updated_by AND NOT NEW.released_without_approval)
       OR (NEW.released_without_approval AND NEW.decided_by IS NULL AND OLD.flow_run_id IS NULL AND NEW.updated_by = OLD.created_by)) THEN
     RAISE EXCEPTION 'A publication is approved by its Flow decider, or released by its submitter when no approval Flow applies.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'pending' AND NEW.status = 'declined' THEN
    IF NEW.decided_by IS DISTINCT FROM NEW.updated_by OR NEW.released_without_approval THEN
     RAISE EXCEPTION 'Decision evidence must name the decider.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'pending' AND NEW.status = 'withdrawn' THEN
    IF NEW.updated_by <> OLD.created_by OR NEW.decided_by IS NOT NULL OR OLD.flow_run_id IS NOT NULL THEN
     RAISE EXCEPTION 'Only the submitter withdraws a publication that no approval Flow owns.' USING ERRCODE = '23514';
    END IF;
   ELSE
    RAISE EXCEPTION 'This publication transition is unavailable; reload the board.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_patterns' THEN
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
   allowed := ARRAY['status','counterpart_responded_by','counterpart_responded_at','flow_run_id','released_without_approval','decided_by','decided_at','decision_reason','revision','updated_at','updated_by'];
   IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'Shift request details are immutable; withdraw it and make a new request.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = OLD.status THEN
    IF ROW(NEW.counterpart_responded_by, NEW.decided_by, NEW.released_without_approval) IS DISTINCT FROM ROW(OLD.counterpart_responded_by, OLD.decided_by, OLD.released_without_approval)
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
    IF NOT ((NEW.decided_by = NEW.updated_by AND NOT NEW.released_without_approval)
       OR (NEW.status = 'approved' AND NEW.released_without_approval AND NEW.decided_by IS NULL AND OLD.flow_run_id IS NULL
           AND NEW.updated_by IN (OLD.created_by, coalesce(OLD.counterpart_responded_by, OLD.created_by)))) THEN
     RAISE EXCEPTION 'A shift request is decided through its approval Flow, or released by its submitter when no approval Flow applies.' USING ERRCODE = '23514';
    END IF;
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

CREATE TRIGGER schedule_roster_guard BEFORE INSERT OR UPDATE OR DELETE ON public.schedule_publications
 FOR EACH ROW EXECUTE FUNCTION public.schedule_roster_guard();
CREATE TRIGGER schedule_roster_audit AFTER INSERT OR UPDATE ON public.schedule_publications
 FOR EACH ROW EXECUTE FUNCTION public.schedule_roster_audit();
ALTER TABLE public.schedule_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.schedule_publications
 USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
 WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.schedule_publications IS 'openbooks:org_isolation:v1';
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.schedule_publications
 FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

DROP FUNCTION public.schedule_assert_independent(uuid, uuid, uuid[], uuid[]);

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('schedule_publications', '0746_scheduling_approvals_through_flows')
ON CONFLICT (relation) DO NOTHING; -- expected on replay; the registry seed is idempotent

SELECT public.openbooks_refresh_query_catalog();
