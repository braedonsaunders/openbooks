-- OpenBooks forward migration 0231_field_time_capture.
--
-- HR-20 field time capture: mobile and kiosk clock-in with geofence,
-- photo and offline queue; cost code at clock-in; foreman crew batch
-- entry with signatures and multi-stage approval; equipment on entries.
--
-- WHAT NEEDS STORAGE:
--
--   time_clock_events — one row per clock action (clock_in, clock_out,
--   break_start, break_end, switch). occurred_at is device time,
--   received_at is the server. client_event_id UNIQUE per org is the
--   offline idempotency key: a replayed batch collapses onto the
--   original rows, never duplicates. pair_id is the in<->out pairing
--   computed by the service. geo_check in (inside, outside,
--   unavailable, not_required): outside is RECORDED and flagged, never
--   refused — a worker must be able to clock; the flag routes to the
--   approver. status in (recorded, paired, voided).
--
--   project_geofences — the enforcement place per project: circle
--   (center + radius_m) or polygon. UNIQUE (project_id, kind): one
--   circle and one polygon per project, never two sources of truth.
--
--   time_kiosks — shared devices. device_token_hash UNIQUE: the raw
--   token is shown once at issue and never stored. pin_required and
--   photo_required are per-kiosk enforcement switches.
--
--   worker_clock_pins — a PIN is a kiosk identity, never a password:
--   scrypt salt:hash like the seed-user KDF, one row per
--   (org, employee). Verification is rate-limited with lockout in the
--   service; the table stores no attempt state.
--
--   crew_time_batches + crew_time_batch_lines — foreman batch per
--   project per day. status in (draft, submitted, approved_stage_1,
--   approved_stage_2, rejected, posted). signature_evidence carries the
--   field-ticket signing HMAC record. Posting creates time_entries with
--   a back-link (crew_batch_line_id); edits after submit are refused —
--   withdraw, edit, resubmit — with history in crew_time_batch_events
--   (append-only: kind, actor, reason, recorded_at).
--
--   time_approval_stages — the multi-stage chain per (org, subject):
--   timesheet_week and crew_time_batch. stages jsonb is validated by
--   the service; a stage is a Flows gate. When the
--   fieldTimeMultiStageApproval feature is off the existing single
--   approval stands and this table is inert.
--
--   time_entries gains equipment_id, equipment_hours (feature-gated in
--   the service; validated against equipment_units active in-org),
--   crew_batch_line_id (back-link to the posting batch line),
--   clock_pair_id (back-link to the clock pairing) and cost_code_ref
--   (the same single cost-code text ref as events and batch lines —
--   time carries no cost-code dimension today, so this column IS the
--   concept, not a second one).
--
--   cost_code_ref on events, batch lines and entries is the org's cost
--   code dimension value. There is no prior cost-code dimension in the
--   product (time carries project/task/department/item + custom), so
--   this text ref IS the single concept — never a second table.
--
-- Additive only. No backfill, no GENERATED column, no change to any
-- existing table or CHECK.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- (1) Clock events.
CREATE TABLE IF NOT EXISTS public.time_clock_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  employee_party_id uuid NOT NULL,
  kind text NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  device_id text,
  source text NOT NULL DEFAULT 'mobile',
  project_id uuid,
  project_task_id uuid,
  cost_code_ref text,
  geo jsonb,
  geo_check text NOT NULL DEFAULT 'not_required',
  photo_file_id uuid REFERENCES public.files(id),
  client_event_id uuid NOT NULL,
  pair_id uuid,
  status text NOT NULL DEFAULT 'recorded',
  auto_closed boolean NOT NULL DEFAULT false,
  void_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_clock_events_kind') THEN
    ALTER TABLE public.time_clock_events
      ADD CONSTRAINT time_clock_events_kind CHECK (
        kind IN ('clock_in', 'clock_out', 'break_start', 'break_end', 'switch'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_clock_events_source') THEN
    ALTER TABLE public.time_clock_events
      ADD CONSTRAINT time_clock_events_source CHECK (
        source IN ('mobile', 'kiosk', 'crew', 'api'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_clock_events_geo_check') THEN
    ALTER TABLE public.time_clock_events
      ADD CONSTRAINT time_clock_events_geo_check CHECK (
        geo_check IN ('inside', 'outside', 'unavailable', 'not_required'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_clock_events_status') THEN
    ALTER TABLE public.time_clock_events
      ADD CONSTRAINT time_clock_events_status CHECK (
        status IN ('recorded', 'paired', 'voided'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_clock_events_void_reason') THEN
    ALTER TABLE public.time_clock_events
      ADD CONSTRAINT time_clock_events_void_reason CHECK (
        (status = 'voided' AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) > 0)
        OR (status <> 'voided'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_clock_events_geo_shape') THEN
    ALTER TABLE public.time_clock_events
      ADD CONSTRAINT time_clock_events_geo_shape CHECK (
        geo IS NULL OR jsonb_typeof(geo) = 'object');
  END IF;
END $$;

-- Party links follow merges like time_entries.employee_party_id.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_clock_events_employee_party_id_fkey') THEN
    ALTER TABLE public.time_clock_events
      ADD CONSTRAINT time_clock_events_employee_party_id_fkey
      FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) DEFERRABLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_clock_pins_employee_party_id_fkey') THEN
    ALTER TABLE public.worker_clock_pins
      ADD CONSTRAINT worker_clock_pins_employee_party_id_fkey
      FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) DEFERRABLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_time_batches_foreman_party_id_fkey') THEN
    ALTER TABLE public.crew_time_batches
      ADD CONSTRAINT crew_time_batches_foreman_party_id_fkey
      FOREIGN KEY (foreman_party_id) REFERENCES public.parties(id) DEFERRABLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_time_batch_lines_employee_party_id_fkey') THEN
    ALTER TABLE public.crew_time_batch_lines
      ADD CONSTRAINT crew_time_batch_lines_employee_party_id_fkey
      FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) DEFERRABLE;
  END IF;
END $$;

-- Offline idempotency key: the same device event replays onto one row.
CREATE UNIQUE INDEX IF NOT EXISTS time_clock_events_org_client_unique
  ON public.time_clock_events (org_id, client_event_id);
CREATE INDEX IF NOT EXISTS time_clock_events_org_employee
  ON public.time_clock_events (org_id, employee_party_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS time_clock_events_org_pair
  ON public.time_clock_events (org_id, pair_id) WHERE pair_id IS NOT NULL;

-- (2) Project geofences.
CREATE TABLE IF NOT EXISTS public.project_geofences (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL,
  center jsonb,
  radius_m integer,
  polygon jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_geofences_kind') THEN
    ALTER TABLE public.project_geofences
      ADD CONSTRAINT project_geofences_kind CHECK (kind IN ('circle', 'polygon'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_geofences_circle_shape') THEN
    ALTER TABLE public.project_geofences
      ADD CONSTRAINT project_geofences_circle_shape CHECK (
        (kind = 'circle' AND center IS NOT NULL AND radius_m IS NOT NULL AND radius_m > 0)
        OR (kind = 'polygon' AND polygon IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS project_geofences_project_kind_unique
  ON public.project_geofences (project_id, kind);
CREATE INDEX IF NOT EXISTS project_geofences_org_project
  ON public.project_geofences (org_id, project_id) WHERE is_active;

-- (3) Kiosk devices.
CREATE TABLE IF NOT EXISTS public.time_kiosks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  location_id uuid,
  project_id uuid,
  pin_required boolean NOT NULL DEFAULT true,
  photo_required boolean NOT NULL DEFAULT false,
  device_token_hash text NOT NULL,
  last_seen_at timestamp with time zone,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_kiosks_name') THEN
    ALTER TABLE public.time_kiosks
      ADD CONSTRAINT time_kiosks_name CHECK (char_length(btrim(name)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_kiosks_token') THEN
    ALTER TABLE public.time_kiosks
      ADD CONSTRAINT time_kiosks_token CHECK (char_length(btrim(device_token_hash)) > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS time_kiosks_token_unique
  ON public.time_kiosks (device_token_hash);
CREATE INDEX IF NOT EXISTS time_kiosks_org
  ON public.time_kiosks (org_id) WHERE is_active;

-- (4) Worker clock PINs (kiosk identity, never a password).
CREATE TABLE IF NOT EXISTS public.worker_clock_pins (
  org_id uuid NOT NULL,
  employee_party_id uuid NOT NULL,
  pin_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (org_id, employee_party_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_clock_pins_hash') THEN
    ALTER TABLE public.worker_clock_pins
      ADD CONSTRAINT worker_clock_pins_hash CHECK (char_length(btrim(pin_hash)) > 0);
  END IF;
END $$;

-- (5) Crew batches + lines + append-only events.
CREATE TABLE IF NOT EXISTS public.crew_time_batches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  foreman_party_id uuid NOT NULL,
  project_id uuid NOT NULL,
  worked_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  signature_evidence jsonb,
  submitted_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_time_batches_status') THEN
    ALTER TABLE public.crew_time_batches
      ADD CONSTRAINT crew_time_batches_status CHECK (
        status IN ('draft', 'submitted', 'approved_stage_1', 'approved_stage_2', 'rejected', 'posted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_time_batches_submitted_at') THEN
    ALTER TABLE public.crew_time_batches
      ADD CONSTRAINT crew_time_batches_submitted_at CHECK (
        (status IN ('draft', 'rejected') AND submitted_at IS NULL)
        OR (status NOT IN ('draft', 'rejected')));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS crew_time_batches_foreman_day_unique
  ON public.crew_time_batches (org_id, foreman_party_id, project_id, worked_on);
CREATE INDEX IF NOT EXISTS crew_time_batches_org_status
  ON public.crew_time_batches (org_id, status);

CREATE TABLE IF NOT EXISTS public.crew_time_batch_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES public.crew_time_batches(id),
  employee_party_id uuid NOT NULL,
  hours numeric(19,4) NOT NULL,
  time_type_id uuid,
  project_task_id uuid,
  cost_code_ref text,
  equipment_id uuid,
  equipment_hours numeric(19,4),
  memo text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_time_batch_lines_hours') THEN
    ALTER TABLE public.crew_time_batch_lines
      ADD CONSTRAINT crew_time_batch_lines_hours CHECK (hours > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_time_batch_lines_equipment_hours') THEN
    ALTER TABLE public.crew_time_batch_lines
      ADD CONSTRAINT crew_time_batch_lines_equipment_hours CHECK (
        equipment_hours IS NULL OR equipment_hours > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_time_batch_lines_equipment_pair') THEN
    ALTER TABLE public.crew_time_batch_lines
      ADD CONSTRAINT crew_time_batch_lines_equipment_pair CHECK (
        (equipment_id IS NULL AND equipment_hours IS NULL)
        OR (equipment_id IS NOT NULL AND equipment_hours IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS crew_time_batch_lines_unique
  ON public.crew_time_batch_lines
  (batch_id, employee_party_id, time_type_id, project_task_id, cost_code_ref, equipment_id);
CREATE INDEX IF NOT EXISTS crew_time_batch_lines_batch
  ON public.crew_time_batch_lines (batch_id);
CREATE INDEX IF NOT EXISTS crew_time_batch_lines_org_employee
  ON public.crew_time_batch_lines (org_id, employee_party_id);

CREATE TABLE IF NOT EXISTS public.crew_time_batch_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  batch_id uuid NOT NULL REFERENCES public.crew_time_batches(id),
  kind text NOT NULL,
  actor_id uuid,
  reason text,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_time_batch_events_kind') THEN
    ALTER TABLE public.crew_time_batch_events
      ADD CONSTRAINT crew_time_batch_events_kind CHECK (
        kind IN ('created', 'line_edited', 'submitted', 'approved_stage_1',
                 'approved_stage_2', 'rejected', 'withdrawn', 'posted', 'voided'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS crew_time_batch_events_batch
  ON public.crew_time_batch_events (batch_id, recorded_at);

-- (6) Multi-stage approval chains per subject.
CREATE TABLE IF NOT EXISTS public.time_approval_stages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subject_kind text NOT NULL,
  stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_approval_stages_subject') THEN
    ALTER TABLE public.time_approval_stages
      ADD CONSTRAINT time_approval_stages_subject CHECK (
        subject_kind IN ('timesheet_week', 'crew_time_batch'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_approval_stages_shape') THEN
    ALTER TABLE public.time_approval_stages
      ADD CONSTRAINT time_approval_stages_shape CHECK (jsonb_typeof(stages) = 'array');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS time_approval_stages_org_subject_unique
  ON public.time_approval_stages (org_id, subject_kind);

-- (7) Additive columns on time_entries.
ALTER TABLE public.time_entries
  ADD COLUMN IF NOT EXISTS equipment_id uuid,
  ADD COLUMN IF NOT EXISTS equipment_hours numeric(19,4),
  ADD COLUMN IF NOT EXISTS crew_batch_line_id uuid,
  ADD COLUMN IF NOT EXISTS clock_pair_id uuid,
  ADD COLUMN IF NOT EXISTS cost_code_ref text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_equipment_hours') THEN
    ALTER TABLE public.time_entries
      ADD CONSTRAINT time_entries_equipment_hours CHECK (
        equipment_hours IS NULL OR equipment_hours > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_equipment_pair') THEN
    ALTER TABLE public.time_entries
      ADD CONSTRAINT time_entries_equipment_pair CHECK (
        (equipment_id IS NULL AND equipment_hours IS NULL)
        OR (equipment_id IS NOT NULL AND equipment_hours IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS time_entries_crew_batch_line
  ON public.time_entries (org_id, crew_batch_line_id) WHERE crew_batch_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS time_entries_clock_pair
  ON public.time_entries (org_id, clock_pair_id) WHERE clock_pair_id IS NOT NULL;

-- Tenant RLS (0195 pattern) on all seven new tables.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'time_clock_events', 'project_geofences', 'time_kiosks',
    'worker_clock_pins', 'crew_time_batches', 'crew_time_batch_lines',
    'crew_time_batch_events', 'time_approval_stages'] LOOP
    EXECUTE format('ALTER TABLE ONLY public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE ONLY public.%I FORCE ROW LEVEL SECURITY', tbl);
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = tbl
                      AND policyname = 'org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY org_isolation ON public.%I
           USING ((current_setting(''app.bypass_rls''::text, true) = ''on''::text)
               OR ((org_id)::text = current_setting(''app.current_org''::text, true)))
           WITH CHECK ((current_setting(''app.bypass_rls''::text, true) = ''on''::text)
               OR ((org_id)::text = current_setting(''app.current_org''::text, true)))',
        tbl);
    END IF;
    EXECUTE format(
      'COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''',
      tbl);
  END LOOP;
END $$;

COMMENT ON TABLE public.time_clock_events IS
  'Field time clock events (0231): device clock actions with the offline idempotency key (org, client_event_id); outside-geofence is recorded and flagged, never refused.';
COMMENT ON TABLE public.project_geofences IS
  'Field time geofences (0231): one circle and one polygon per project; the enforcement place for clock-in location.';
COMMENT ON TABLE public.time_kiosks IS
  'Field time kiosks (0231): shared clock devices; the raw device token is shown once at issue, only the hash is stored.';
COMMENT ON TABLE public.worker_clock_pins IS
  'Field time clock PINs (0231): kiosk identity per (org, employee), scrypt-hashed; never a password.';
COMMENT ON TABLE public.crew_time_batches IS
  'Field crew batches (0231): foreman batch per project per day with signed submit and multi-stage approval; posting creates time_entries.';
COMMENT ON TABLE public.crew_time_batch_lines IS
  'Field crew batch lines (0231): one row per worker/time-type/task/cost-code/equipment; equipment pair is all-or-nothing.';
COMMENT ON TABLE public.crew_time_batch_events IS
  'Field crew batch history (0231): append-only lifecycle evidence; edits after submit are refused, never overwritten.';
COMMENT ON TABLE public.time_approval_stages IS
  'Field multi-stage approval (0231): per-(org, subject) Flows gate chain; inert when fieldTimeMultiStageApproval is off.';
