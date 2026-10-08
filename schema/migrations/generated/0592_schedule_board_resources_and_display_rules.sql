-- Native equipment/location resource bookings share the booking lifecycle and
-- cross-board availability guards. Display settings change presentation only.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE FUNCTION public.schedule_cell_color_rules_valid(rules jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $function$
 SELECT CASE WHEN jsonb_typeof(rules) = 'array' THEN
  jsonb_array_length(rules) <= 100 AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(rules) rule WHERE NOT CASE WHEN jsonb_typeof(rule) = 'object' THEN coalesce(
    rule - ARRAY['field','match','value','color'] = '{}'::jsonb
    AND rule->>'field' IN ('bookingLabel','targetName','detail')
    AND rule->>'match' IN ('equals','startsWith','contains')
    AND jsonb_typeof(rule->'value') = 'string' AND length(btrim(rule->>'value')) BETWEEN 1 AND 120
    AND jsonb_typeof(rule->'color') = 'string' AND rule->>'color' ~ '^#[0-9a-fA-F]{6}$', false) ELSE false END)
 ELSE false END;
$function$;

ALTER TABLE public.schedule_boards
 ADD COLUMN resource_kind text,
 ADD COLUMN cell_color_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
 ADD COLUMN show_totals boolean NOT NULL DEFAULT false,
 ADD COLUMN weekend_days text[] NOT NULL DEFAULT ARRAY['6','7']::text[],
 DROP CONSTRAINT schedule_boards_row_kind_check,
 ADD CONSTRAINT schedule_boards_row_kind_check CHECK (row_kind IN ('people','tasks','resources')),
 ADD CONSTRAINT schedule_boards_resource_kind CHECK (
  (row_kind = 'resources' AND coalesce(resource_kind IN ('equipment','location'),false) AND department_id IS NULL
   AND (resource_kind = 'location' OR location_id IS NULL))
  OR (row_kind <> 'resources' AND resource_kind IS NULL)),
 ADD CONSTRAINT schedule_boards_cell_color_rules CHECK (public.schedule_cell_color_rules_valid(cell_color_rules)),
 ADD CONSTRAINT schedule_boards_weekend_days CHECK (coalesce(array_ndims(weekend_days),1) = 1 AND weekend_days <@ ARRAY['1','2','3','4','5','6','7']::text[]);

CREATE OR REPLACE FUNCTION public.schedule_board_views_valid(row_kind text, views text[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $function$
 SELECT coalesce(array_length(views,1),0) BETWEEN 1 AND 6 AND array_ndims(views) = 1
  AND (SELECT count(DISTINCT v) FROM unnest(views) v) = array_length(views,1)
  AND views <@ CASE row_kind WHEN 'people' THEN ARRAY['grid','targets','timeline','calendar']::text[]
   WHEN 'resources' THEN ARRAY['grid','targets','timeline','calendar']::text[]
   WHEN 'tasks' THEN ARRAY['gantt','progress']::text[] ELSE ARRAY[]::text[] END;
$function$;

ALTER TABLE public.schedule_entries
 ALTER COLUMN worker_party_id DROP NOT NULL,
 ADD COLUMN equipment_unit_id uuid,
 ADD COLUMN resource_location_id uuid,
 ADD CONSTRAINT schedule_entries_equipment_unit_fkey FOREIGN KEY (org_id,equipment_unit_id) REFERENCES public.equipment_units(org_id,id),
 ADD CONSTRAINT schedule_entries_resource_location_fkey FOREIGN KEY (org_id,resource_location_id) REFERENCES public.locations(org_id,id),
 ADD CONSTRAINT schedule_entries_subject CHECK (num_nonnulls(worker_party_id,equipment_unit_id,resource_location_id) = 1
  AND (worker_party_id IS NOT NULL OR employment_id IS NULL)),
 ADD CONSTRAINT schedule_entries_equipment_no_double_booking EXCLUDE USING gist (
  org_id WITH =, equipment_unit_id WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&) WHERE (status = 'published' AND equipment_unit_id IS NOT NULL),
 ADD CONSTRAINT schedule_entries_location_no_double_booking EXCLUDE USING gist (
  org_id WITH =, resource_location_id WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&) WHERE (status = 'published' AND resource_location_id IS NOT NULL);
CREATE INDEX schedule_entries_equipment_window ON public.schedule_entries(org_id,equipment_unit_id,starts_on) WHERE equipment_unit_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX schedule_entries_resource_location_window ON public.schedule_entries(org_id,resource_location_id,starts_on) WHERE resource_location_id IS NOT NULL AND status <> 'cancelled';

CREATE OR REPLACE FUNCTION public.schedule_boards_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM public.schedule_entries WHERE org_id = OLD.org_id AND board_id = OLD.id) THEN
   RAISE EXCEPTION 'This board has booking history; archive it instead of deleting it.' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
  RAISE EXCEPTION 'The board time zone is unknown; select a named time zone such as America/Toronto.' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND ROW(NEW.row_kind, NEW.resource_kind) IS DISTINCT FROM ROW(OLD.row_kind, OLD.resource_kind) THEN
  RAISE EXCEPTION 'A board keeps its row type; create a new board for a different kind of schedule.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.schedule_entries_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE board public.schedule_boards; prior public.schedule_entries; last_date date; editable text[];
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
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
  IF ROW(NEW.id, NEW.org_id, NEW.board_id, NEW.created_at, NEW.created_by, NEW.request_hash, NEW.supersedes_id)
     IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.board_id, OLD.created_at, OLD.created_by, OLD.request_hash, OLD.supersedes_id) THEN
   RAISE EXCEPTION 'A booking keeps its board, creation evidence and predecessor; create a new booking instead.' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
   RAISE EXCEPTION 'The booking changed since it was loaded; reload the board and try again.' USING ERRCODE = '40001';
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

 IF TG_OP = 'INSERT' THEN
  IF NOT board.is_active THEN
   RAISE EXCEPTION 'This board is archived; reactivate it in Setup before booking.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'published' THEN
   IF board.publish_policy <> 'live' THEN
    RAISE EXCEPTION 'This board publishes changes together; save the booking as a draft and publish the board.' USING ERRCODE = '23514';
   END IF;
   IF NEW.published_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'Publication evidence must name the person who booked it.' USING ERRCODE = '23514';
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
  END IF;
 ELSIF OLD.status = 'draft' THEN
  IF NEW.status = 'published' THEN
   IF NEW.published_by IS DISTINCT FROM NEW.updated_by OR NEW.published_at IS NULL THEN
    RAISE EXCEPTION 'Publication evidence must name the publisher.' USING ERRCODE = '23514';
   END IF;
   IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.supersedes_id AND status = 'cancelled') THEN
    RAISE EXCEPTION 'Publishing a replacement cancels the booking it replaces in the same command.' USING ERRCODE = '23514';
   END IF;
  ELSIF NEW.status NOT IN ('draft','cancelled') OR NEW.published_by IS NOT NULL THEN
   RAISE EXCEPTION 'A draft booking can be edited, published or cancelled.' USING ERRCODE = '23514';
  END IF;
 ELSIF OLD.status = 'published' THEN
  editable := ARRAY['status','notes','reason','revision','updated_at','updated_by'];
  IF to_jsonb(NEW) - editable IS DISTINCT FROM to_jsonb(OLD) - editable OR NEW.status NOT IN ('published','cancelled') THEN
   RAISE EXCEPTION 'A published booking keeps its person or resource, target and times; change it on the board, which records a replacement.' USING ERRCODE = '23514';
  END IF;
 ELSE
  RAISE EXCEPTION 'Cancelled bookings are history; create a new booking.' USING ERRCODE = '23514';
 END IF;

 IF NEW.status IN ('draft','published') AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
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
 END IF;
 IF NEW.worker_party_id IS NOT NULL AND NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
  PERFORM public.schedule_entry_assert_available(NEW);
 END IF;
 RETURN NEW;
END $function$;

COMMENT ON COLUMN public.schedule_entries.equipment_unit_id IS 'Native chargeable unit reserved by this planning booking; no charge or accounting entry is recorded.';
COMMENT ON COLUMN public.schedule_entries.resource_location_id IS 'Native location reserved as the subject, independently of the booking destination.';
SELECT public.openbooks_refresh_query_catalog();
