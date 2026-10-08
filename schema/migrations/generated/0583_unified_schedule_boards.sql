-- OpenBooks forward migration 0583_unified_schedule_boards.
-- Unified scheduling: boards define a scoped lens over people or project
-- tasks, schedule codes name non-project bookings, schedule entries are the
-- single booking ledger for every people board.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- Task references carry their project so a booking can never name a task
-- from another project.
CREATE UNIQUE INDEX project_tasks_org_project_id_key ON public.project_tasks(org_id, project_id, id);

CREATE FUNCTION public.schedule_board_views_valid(row_kind text, views text[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$
  SELECT coalesce(array_length(views, 1), 0) BETWEEN 1 AND 6
     AND array_ndims(views) = 1
     AND (SELECT count(DISTINCT v) FROM unnest(views) v) = array_length(views, 1)
     AND views <@ CASE row_kind
       WHEN 'people' THEN ARRAY['grid','targets','timeline','calendar']::text[]
       WHEN 'tasks' THEN ARRAY['gantt','progress']::text[]
       ELSE ARRAY[]::text[] END;
$$;

CREATE TABLE public.schedule_boards (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND name = btrim(name)),
 description text CHECK (description IS NULL OR length(description) <= 2000),
 row_kind text NOT NULL CHECK (row_kind IN ('people','tasks')),
 subsidiary_id uuid,
 department_id uuid,
 location_id uuid,
 project_id uuid,
 grain text NOT NULL DEFAULT 'day' CHECK (grain IN ('day','timed')),
 views text[] NOT NULL,
 default_view text NOT NULL,
 range_days smallint NOT NULL DEFAULT 14 CHECK (range_days IN (1,3,7,14,21,28,35,42)),
 week_starts_on smallint NOT NULL DEFAULT 0 CHECK (week_starts_on BETWEEN 0 AND 6),
 show_weekends boolean NOT NULL DEFAULT true,
 time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
 day_starts time NOT NULL DEFAULT '07:00',
 day_ends time NOT NULL DEFAULT '15:30',
 day_break_minutes smallint NOT NULL DEFAULT 30 CHECK (day_break_minutes BETWEEN 0 AND 240),
 publish_policy text NOT NULL DEFAULT 'live' CHECK (publish_policy IN ('live','staged')),
 prefill_timesheets boolean NOT NULL DEFAULT false,
 prefill_crew_time boolean NOT NULL DEFAULT false,
 prefill_field_tickets boolean NOT NULL DEFAULT false,
 notify_assignees boolean NOT NULL DEFAULT false,
 sort_order integer NOT NULL DEFAULT 0,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id, id),
 UNIQUE (org_id, code),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id),
 FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id),
 FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id),
 CONSTRAINT schedule_boards_views_valid CHECK (public.schedule_board_views_valid(row_kind, views)),
 CONSTRAINT schedule_boards_default_view_listed CHECK (default_view = ANY (views)),
 CONSTRAINT schedule_boards_day_span CHECK (day_ends > day_starts AND extract(epoch FROM day_ends - day_starts) > day_break_minutes * 60),
 -- Booking behavior applies to people boards; task boards schedule activities.
 CONSTRAINT schedule_boards_people_settings CHECK (row_kind = 'people' OR NOT (prefill_timesheets OR prefill_crew_time OR prefill_field_tickets OR notify_assignees))
);
CREATE INDEX schedule_boards_scope ON public.schedule_boards(org_id, is_active, sort_order, name);
COMMENT ON TABLE public.schedule_boards IS
 'Scheduling boards: a scoped lens (legal entity, department, location, project) over people or project tasks, with its views, publication policy and booking behavior.';

CREATE TABLE public.schedule_codes (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9/&+._-]{0,15}$'),
 label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80 AND label = btrim(label)),
 description text CHECK (description IS NULL OR length(description) <= 2000),
 category text NOT NULL CHECK (category IN ('work','unavailable')),
 color text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
 sort_order integer NOT NULL DEFAULT 0,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id, id),
 UNIQUE (org_id, code)
);
COMMENT ON TABLE public.schedule_codes IS
 'Organization-defined booking codes for non-project work (training, shop) and unavailability (forced day off). Work codes count as scheduled time; unavailable codes occupy the day without counting.';

CREATE TABLE public.schedule_entries (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 board_id uuid NOT NULL,
 worker_party_id uuid NOT NULL,
 employment_id uuid,
 subsidiary_id uuid,
 target_kind text CHECK (target_kind IN ('customer','project','location','code')),
 customer_party_id uuid,
 project_id uuid,
 project_task_id uuid,
 location_id uuid,
 schedule_code_id uuid,
 department_id uuid,
 detail text CHECK (detail IS NULL OR (length(btrim(detail)) BETWEEN 1 AND 120 AND detail = btrim(detail))),
 notes text CHECK (notes IS NULL OR length(notes) <= 2000),
 span_mode text NOT NULL CHECK (span_mode IN ('day','timed')),
 time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 128),
 starts_on date NOT NULL CHECK (starts_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 ends_on date NOT NULL CHECK (ends_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 starts_at timestamptz NOT NULL CHECK (starts_at = date_trunc('milliseconds', starts_at)),
 ends_at timestamptz NOT NULL CHECK (ends_at = date_trunc('milliseconds', ends_at)),
 break_minutes smallint NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 240),
 series_id uuid,
 supersedes_id uuid,
 status text NOT NULL CHECK (status IN ('draft','published','cancelled')),
 published_by uuid, published_at timestamptz,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 UNIQUE (org_id, id),
 UNIQUE (org_id, supersedes_id),
 FOREIGN KEY (org_id, board_id) REFERENCES public.schedule_boards(org_id, id),
 FOREIGN KEY (org_id, worker_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, customer_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id),
 -- Deferred so a governed project merge can move tasks and bookings together.
 FOREIGN KEY (org_id, project_id, project_task_id) REFERENCES public.project_tasks(org_id, project_id, id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id),
 FOREIGN KEY (org_id, schedule_code_id) REFERENCES public.schedule_codes(org_id, id),
 FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id),
 FOREIGN KEY (org_id, supersedes_id) REFERENCES public.schedule_entries(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, published_by) REFERENCES public.users(org_id, id),
 CONSTRAINT schedule_entries_span CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '48 hours'
   AND break_minutes * 60 < extract(epoch FROM ends_at - starts_at) AND ends_on >= starts_on AND ends_on - starts_on <= 2),
 CONSTRAINT schedule_entries_target CHECK (
   (target_kind IS NULL AND customer_party_id IS NULL AND project_id IS NULL AND location_id IS NULL AND schedule_code_id IS NULL)
   OR (target_kind = 'customer' AND customer_party_id IS NOT NULL AND project_id IS NULL AND location_id IS NULL AND schedule_code_id IS NULL)
   OR (target_kind = 'project' AND project_id IS NOT NULL AND customer_party_id IS NULL AND location_id IS NULL AND schedule_code_id IS NULL)
   OR (target_kind = 'location' AND location_id IS NOT NULL AND customer_party_id IS NULL AND project_id IS NULL AND schedule_code_id IS NULL)
   OR (target_kind = 'code' AND schedule_code_id IS NOT NULL AND customer_party_id IS NULL AND project_id IS NULL AND location_id IS NULL)),
 CONSTRAINT schedule_entries_task_needs_project CHECK (project_task_id IS NULL OR project_id IS NOT NULL),
 CONSTRAINT schedule_entries_publication_evidence CHECK ((published_by IS NULL) = (published_at IS NULL)
   AND (status <> 'published' OR published_by IS NOT NULL)),
 -- A person is booked at most once at any instant across every board.
 CONSTRAINT schedule_entries_no_double_booking EXCLUDE USING gist (
   org_id WITH =, worker_party_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status = 'published')
);
CREATE INDEX schedule_entries_board_window ON public.schedule_entries(org_id, board_id, starts_on) WHERE status <> 'cancelled';
CREATE INDEX schedule_entries_worker_window ON public.schedule_entries(org_id, worker_party_id, starts_on) WHERE status <> 'cancelled';
CREATE INDEX schedule_entries_project_window ON public.schedule_entries(org_id, project_id, starts_on) WHERE project_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX schedule_entries_customer_window ON public.schedule_entries(org_id, customer_party_id, starts_on) WHERE customer_party_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX schedule_entries_series ON public.schedule_entries(org_id, series_id) WHERE series_id IS NOT NULL;
COMMENT ON TABLE public.schedule_entries IS
 'The booking ledger for people boards: one person, one target, one span. Published entries never overlap for a person; changes to a published entry cancel it and record a successor.';

-- Board configuration is checked against the live catalog of time zones.
CREATE FUNCTION public.schedule_boards_guard() RETURNS trigger
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
 IF TG_OP = 'UPDATE' AND NEW.row_kind IS DISTINCT FROM OLD.row_kind THEN
  RAISE EXCEPTION 'A board keeps its row type; create a new board for a different kind of schedule.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_boards_guard BEFORE INSERT OR UPDATE OR DELETE ON public.schedule_boards
 FOR EACH ROW EXECUTE FUNCTION public.schedule_boards_guard();

CREATE FUNCTION public.schedule_codes_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM public.schedule_entries WHERE org_id = OLD.org_id AND schedule_code_id = OLD.id) THEN
   RAISE EXCEPTION 'This schedule code is used by bookings; deactivate it instead of deleting it.' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' AND NEW.category IS DISTINCT FROM OLD.category
    AND EXISTS (SELECT 1 FROM public.schedule_entries WHERE org_id = OLD.org_id AND schedule_code_id = OLD.id AND status <> 'cancelled') THEN
  RAISE EXCEPTION 'The category of a code in use is fixed, because it decides whether booked days count as work; create a new code instead.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_codes_guard BEFORE UPDATE OR DELETE ON public.schedule_codes
 FOR EACH ROW EXECUTE FUNCTION public.schedule_codes_guard();

-- Whether a person can be booked on every date of a span: an active employee
-- role covers the dates, and a named HR employment belongs to that person and
-- is active for the whole span.
CREATE FUNCTION public.schedule_entry_assert_worker(tenant uuid, worker uuid, employment uuid, from_on date, through_on date) RETURNS void
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 PERFORM 1 FROM public.employee_roles r
  WHERE r.org_id = tenant AND r.party_id = worker AND r.is_active
    AND (r.hired_on IS NULL OR r.hired_on <= from_on)
    AND (r.terminated_on IS NULL OR r.terminated_on >= through_on)
  FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'This person has no active employee role covering %; book an active employee or correct their hire and termination dates.', from_on USING ERRCODE = '23514';
 END IF;
 IF employment IS NOT NULL THEN
  PERFORM 1 FROM public.worker_employments e WHERE e.org_id = tenant AND e.id = employment AND e.worker_party_id = worker FOR SHARE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'The employment does not belong to this person; select the person again.' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT employment_id FROM public.worker_employment_versions
   WHERE org_id = tenant AND employment_id = employment AND recorded_until IS NULL AND status = 'active'
   GROUP BY employment_id HAVING range_agg(daterange(effective_from, effective_to, '[)')) @> daterange(from_on, through_on, '[]')) THEN
   RAISE EXCEPTION 'Active employment history does not cover %; choose a covered date or record the employment change first.', from_on USING ERRCODE = '23514';
  END IF;
 END IF;
END $function$;

-- Publication refuses recorded leave and published roster shifts that the
-- booking would overlap, so a person is never shown in two places at once.
CREATE FUNCTION public.schedule_entry_assert_available(entry public.schedule_entries) RETURNS void
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
 IF EXISTS (SELECT 1 FROM public.hrm_shifts s WHERE s.org_id = entry.org_id AND s.worker_party_id = entry.worker_party_id
   AND s.status IN ('published','closed') AND tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(entry.starts_at, entry.ends_at, '[)')) THEN
  RAISE EXCEPTION 'This person already works a published roster shift at that time; choose another time or person.' USING ERRCODE = '23514';
 END IF;
END $function$;

CREATE FUNCTION public.schedule_entries_guard() RETURNS trigger
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
 IF NOT FOUND OR board.row_kind <> 'people' THEN
  RAISE EXCEPTION 'Bookings belong to a people board; select a people board.' USING ERRCODE = '23514';
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
   RAISE EXCEPTION 'A published booking keeps its person, target and times; change it on the board, which records a replacement.' USING ERRCODE = '23514';
  END IF;
 ELSE
  RAISE EXCEPTION 'Cancelled bookings are history; create a new booking.' USING ERRCODE = '23514';
 END IF;

 IF NEW.status IN ('draft','published') AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
  PERFORM public.schedule_entry_assert_worker(NEW.org_id, NEW.worker_party_id, NEW.employment_id, NEW.starts_on, last_date);
 END IF;
 IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
  PERFORM public.schedule_entry_assert_available(NEW);
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON public.schedule_entries
 FOR EACH ROW EXECUTE FUNCTION public.schedule_entries_guard();

CREATE FUNCTION public.schedule_entries_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id, table_name, row_id, action, actor_id, changes)
 VALUES (NEW.org_id, TG_TABLE_NAME, NEW.id, lower(TG_OP),
  CASE WHEN public.openbooks_clone_authority() THEN NULL ELSE NEW.updated_by END,
  jsonb_build_object('before', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END, 'after', to_jsonb(NEW),
   'reason', CASE WHEN public.openbooks_clone_authority() THEN 'Preserve bookings during controlled sandbox cloning.' ELSE NEW.reason END));
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_entries_audit AFTER INSERT OR UPDATE ON public.schedule_entries
 FOR EACH ROW EXECUTE FUNCTION public.schedule_entries_audit();

DO $block$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['schedule_boards','schedule_codes','schedule_entries'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true))', tbl);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''', tbl);
 END LOOP;
END $block$;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('schedule_boards', '0583_unified_schedule_boards'),
 ('schedule_codes', '0583_unified_schedule_boards'),
 ('schedule_entries', '0583_unified_schedule_boards')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
