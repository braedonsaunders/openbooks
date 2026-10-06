-- OpenBooks forward migration 0552_hrm_shift_attendance.
-- Operational roster publication and device attendance preserve native
-- employment identities, independent approval and immutable source evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE UNIQUE INDEX hrm_shift_work_schedule_subject ON public.work_schedules(org_id,id);
CREATE UNIQUE INDEX hrm_shift_employment_subject ON public.worker_employments(org_id,employer_subsidiary_id,worker_party_id,id);

CREATE TABLE public.hrm_shift_templates (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL, normal_work_schedule_id uuid NOT NULL,
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 64 AND code=btrim(code)), version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160), description text CHECK(length(description)<=2000),
 effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 effective_to date CHECK(effective_to>effective_from AND effective_to<=DATE '9999-12-31'),
 pattern jsonb NOT NULL CHECK(jsonb_typeof(pattern)='object'), attendance_policy jsonb CHECK(attendance_policy IS NULL OR jsonb_typeof(attendance_policy)='object'),
 definition_hash text NOT NULL CHECK(definition_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired','cancelled')),
 author_party_id uuid NOT NULL, decided_by uuid, decided_at timestamptz,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,normal_work_schedule_id) REFERENCES public.work_schedules(org_id,id),
 UNIQUE(org_id,subsidiary_id,code,version),
 UNIQUE(org_id,subsidiary_id,id),
 CHECK((status IN ('approved','retired'))=(decided_by IS NOT NULL AND decided_at IS NOT NULL)), CHECK((decided_by IS NULL)=(decided_at IS NULL)),
 EXCLUDE USING gist(org_id WITH =,subsidiary_id WITH =,code WITH =,daterange(effective_from,effective_to,'[)') WITH &&) WHERE(status='approved'),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,author_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,decided_by) REFERENCES public.users(org_id,id)
);

CREATE TABLE public.hrm_shift_assignments (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 template_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL, employment_id uuid NOT NULL, worker_party_id uuid NOT NULL,
 effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 effective_to date CHECK(effective_to>effective_from AND effective_to<=DATE '9999-12-31'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','ended','cancelled')),
 author_party_id uuid NOT NULL, decided_by uuid, decided_at timestamptz,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,template_id) REFERENCES public.hrm_shift_templates(org_id,subsidiary_id,id),
 UNIQUE(org_id,employment_id,id),
 CHECK((status IN ('approved','ended'))=(decided_by IS NOT NULL AND decided_at IS NOT NULL)), CHECK((decided_by IS NULL)=(decided_at IS NULL)),
 EXCLUDE USING gist(org_id WITH =,worker_party_id WITH =,daterange(effective_from,effective_to,'[)') WITH &&) WHERE(status IN ('approved','ended')),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,author_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,decided_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,worker_party_id,employment_id) REFERENCES public.worker_employments(org_id,employer_subsidiary_id,worker_party_id,id)
);

CREATE TABLE public.hrm_shift_publications (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 assignment_id uuid NOT NULL,
 from_on date NOT NULL CHECK(from_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 through_on date NOT NULL CHECK(through_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 assignment_revision integer NOT NULL CHECK(assignment_revision>0),
 definition_hash text NOT NULL CHECK(definition_hash ~ '^[0-9a-f]{64}$'),
 occurrence_selections jsonb NOT NULL CHECK(jsonb_typeof(occurrence_selections)='object'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,assignment_id) REFERENCES public.hrm_shift_assignments(org_id,id),
 CHECK(through_on>=from_on AND through_on-from_on<366),
 UNIQUE(org_id,assignment_id,id),
 EXCLUDE USING gist(org_id WITH =,assignment_id WITH =,daterange(from_on,through_on,'[]') WITH &&),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id)
);

CREATE TABLE public.hrm_shifts (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL, employment_id uuid NOT NULL, worker_party_id uuid NOT NULL,
 template_id uuid, publication_id uuid, slot_index integer CHECK(slot_index>=0), supersedes_id uuid, origin_request_id uuid,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160), time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 128),
 starts_on date NOT NULL CHECK(starts_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 ends_on date NOT NULL CHECK(ends_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 starts_at timestamptz NOT NULL CHECK(starts_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00' AND starts_at=date_trunc('milliseconds',starts_at)),
 ends_at timestamptz NOT NULL CHECK(ends_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00' AND ends_at=date_trunc('milliseconds',ends_at)),
 planned_break_seconds integer NOT NULL CHECK(planned_break_seconds>=0), qualification_type_ids jsonb NOT NULL CHECK(jsonb_typeof(qualification_type_ids)='array'), attendance_policy jsonb CHECK(attendance_policy IS NULL OR jsonb_typeof(attendance_policy)='object'),
 definition_hash text NOT NULL CHECK(definition_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed','cancelled')),
 author_party_id uuid NOT NULL, decided_by uuid, decided_at timestamptz,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,template_id) REFERENCES public.hrm_shift_templates(org_id,subsidiary_id,id),
 FOREIGN KEY(org_id,publication_id) REFERENCES public.hrm_shift_publications(org_id,id),
 FOREIGN KEY(org_id,employment_id,supersedes_id) REFERENCES public.hrm_shifts(org_id,employment_id,id),
 UNIQUE(org_id,employment_id,id),
 UNIQUE(org_id,publication_id,starts_on,slot_index),
 UNIQUE(org_id,supersedes_id),
 CHECK((publication_id IS NULL AND slot_index IS NULL) OR (publication_id IS NOT NULL AND slot_index IS NOT NULL AND template_id IS NOT NULL)),
 CHECK(ends_at>starts_at AND ends_at-starts_at<=interval '48 hours' AND planned_break_seconds<extract(epoch FROM ends_at-starts_at)),
 CHECK(ends_on>=starts_on AND ends_on-starts_on<=2),
 CHECK((decided_by IS NULL)=(decided_at IS NULL)), CHECK(status NOT IN ('published','closed') OR decided_by IS NOT NULL),
 EXCLUDE USING gist(org_id WITH =,worker_party_id WITH =,tstzrange(starts_at,ends_at,'[)') WITH &&) WHERE(status IN ('published','closed')),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,author_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,decided_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,worker_party_id,employment_id) REFERENCES public.worker_employments(org_id,employer_subsidiary_id,worker_party_id,id)
);

CREATE TABLE public.hrm_shift_requests (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 shift_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL, employment_id uuid NOT NULL, worker_party_id uuid NOT NULL,
 shift_revision integer NOT NULL CHECK(shift_revision>0),
 kind text NOT NULL CHECK(kind IN ('release','change')), proposed_starts_at timestamptz, proposed_ends_at timestamptz, outcome_shift_id uuid,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','withdrawn')),
 author_party_id uuid NOT NULL, decided_by uuid, decided_at timestamptz,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,employment_id,shift_id) REFERENCES public.hrm_shifts(org_id,employment_id,id),
 FOREIGN KEY(org_id,employment_id,outcome_shift_id) REFERENCES public.hrm_shifts(org_id,employment_id,id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(org_id,employment_id,id),
 CHECK((kind='release' AND proposed_starts_at IS NULL AND proposed_ends_at IS NULL AND outcome_shift_id IS NULL) OR (kind='change' AND proposed_starts_at IS NOT NULL AND proposed_ends_at>proposed_starts_at AND proposed_ends_at-proposed_starts_at<=interval '48 hours')),
 CHECK((status IN ('approved','declined'))=(decided_by IS NOT NULL AND decided_at IS NOT NULL)), CHECK((decided_by IS NULL)=(decided_at IS NULL)), CHECK(outcome_shift_id IS NULL OR status='approved'),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,author_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,decided_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,worker_party_id,employment_id) REFERENCES public.worker_employments(org_id,employer_subsidiary_id,worker_party_id,id)
);

ALTER TABLE public.hrm_shifts ADD FOREIGN KEY(org_id,employment_id,origin_request_id) REFERENCES public.hrm_shift_requests(org_id,employment_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX hrm_shift_requests_pending ON public.hrm_shift_requests(org_id,shift_id) WHERE status='pending';
ALTER TABLE public.hrm_shift_requests ADD CONSTRAINT hrm_shift_request_finite_instants CHECK(
 proposed_starts_at IS NULL OR (proposed_starts_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
 AND proposed_ends_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00'
 AND proposed_starts_at=date_trunc('milliseconds',proposed_starts_at) AND proposed_ends_at=date_trunc('milliseconds',proposed_ends_at)));

CREATE TABLE public.hrm_attendance_devices (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 64 AND code=btrim(code)), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160), time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 128), is_active boolean NOT NULL DEFAULT true,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 UNIQUE(org_id,code),
 UNIQUE(org_id,subsidiary_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id)
);

CREATE TABLE public.hrm_attendance_identities (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 device_id uuid NOT NULL, source_worker_id text NOT NULL CHECK(length(btrim(source_worker_id)) BETWEEN 1 AND 160),
 subsidiary_id uuid NOT NULL, employment_id uuid NOT NULL, worker_party_id uuid NOT NULL,
 effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 effective_to date CHECK(effective_to>effective_from AND effective_to<=DATE '9999-12-31'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,device_id) REFERENCES public.hrm_attendance_devices(org_id,subsidiary_id,id),
 UNIQUE(org_id,device_id,id),
 EXCLUDE USING gist(org_id WITH =,device_id WITH =,source_worker_id WITH =,daterange(effective_from,effective_to,'[)') WITH &&),
 EXCLUDE USING gist(org_id WITH =,device_id WITH =,worker_party_id WITH =,daterange(effective_from,effective_to,'[)') WITH &&),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,worker_party_id,employment_id) REFERENCES public.worker_employments(org_id,employer_subsidiary_id,worker_party_id,id)
);

CREATE TABLE public.hrm_attendance_batches (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 device_id uuid NOT NULL, complete_through timestamptz,
 source_evidence jsonb NOT NULL CHECK(jsonb_typeof(source_evidence)='object'), event_count integer NOT NULL CHECK(event_count BETWEEN 0 AND 10000),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,device_id) REFERENCES public.hrm_attendance_devices(org_id,id),
 UNIQUE(org_id,device_id,id),
 CHECK(complete_through IS NULL OR (complete_through BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00' AND complete_through=date_trunc('milliseconds',complete_through))),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id)
);

CREATE TABLE public.hrm_attendance_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 device_id uuid NOT NULL, batch_id uuid NOT NULL, identity_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL, employment_id uuid NOT NULL, worker_party_id uuid NOT NULL,
 source_event_id text NOT NULL CHECK(length(btrim(source_event_id)) BETWEEN 1 AND 160), source_version integer NOT NULL CHECK(source_version>0), kind text NOT NULL CHECK(kind IN ('clock_in','clock_out','break_start','break_end','void')),
 occurred_at timestamptz NOT NULL CHECK(occurred_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00' AND occurred_at=date_trunc('milliseconds',occurred_at)),
 source_local_date date NOT NULL CHECK(source_local_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 source_payload jsonb NOT NULL CHECK(jsonb_typeof(source_payload)='object'), supersedes_id uuid,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,device_id,batch_id) REFERENCES public.hrm_attendance_batches(org_id,device_id,id),
 FOREIGN KEY(org_id,device_id,identity_id) REFERENCES public.hrm_attendance_identities(org_id,device_id,id),
 FOREIGN KEY(org_id,device_id,source_event_id,supersedes_id) REFERENCES public.hrm_attendance_events(org_id,device_id,source_event_id,id),
 UNIQUE(org_id,device_id,source_event_id,id),
 UNIQUE(org_id,device_id,source_event_id,source_version),
 UNIQUE(org_id,supersedes_id),
 CHECK((source_version=1 AND supersedes_id IS NULL AND kind<>'void') OR (source_version>1 AND supersedes_id IS NOT NULL)),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,worker_party_id,employment_id) REFERENCES public.worker_employments(org_id,employer_subsidiary_id,worker_party_id,id)
);

CREATE TABLE public.hrm_attendance_watermarks (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 device_id uuid NOT NULL, batch_id uuid NOT NULL,
 complete_through timestamptz NOT NULL CHECK(complete_through BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999+00' AND complete_through=date_trunc('milliseconds',complete_through)),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,device_id,batch_id) REFERENCES public.hrm_attendance_batches(org_id,device_id,id),
 UNIQUE(org_id,device_id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id)
);

CREATE TABLE public.hrm_attendance_observations (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 shift_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL, employment_id uuid NOT NULL, worker_party_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('waiting_for_sync','absent','present','voided')), complete_through timestamptz, first_in timestamptz, last_out timestamptz,
 presence_milliseconds bigint CHECK(presence_milliseconds>=0), break_milliseconds bigint CHECK(break_milliseconds>=0), late boolean, left_early boolean,
 source_evidence jsonb NOT NULL CHECK(jsonb_typeof(source_evidence)='object'),
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 supersedes_id uuid,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,employment_id,shift_id) REFERENCES public.hrm_shifts(org_id,employment_id,id),
 FOREIGN KEY(org_id,shift_id,supersedes_id) REFERENCES public.hrm_attendance_observations(org_id,shift_id,id),
 UNIQUE(org_id,shift_id,id),
 UNIQUE(org_id,supersedes_id),
 CHECK((status IN ('waiting_for_sync','voided') AND presence_milliseconds IS NULL AND break_milliseconds IS NULL AND late IS NULL AND left_early IS NULL AND first_in IS NULL AND last_out IS NULL) OR (status='absent' AND presence_milliseconds=0 AND break_milliseconds=0 AND late=false AND left_early=false AND first_in IS NULL AND last_out IS NULL) OR (status='present' AND presence_milliseconds IS NOT NULL AND break_milliseconds IS NOT NULL AND late IS NOT NULL AND left_early IS NOT NULL AND first_in IS NOT NULL AND last_out>first_in AND presence_milliseconds+break_milliseconds<=extract(epoch FROM last_out-first_in)*1000)),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id,worker_party_id,employment_id) REFERENCES public.worker_employments(org_id,employer_subsidiary_id,worker_party_id,id)
);

CREATE UNIQUE INDEX hrm_attendance_observations_first ON public.hrm_attendance_observations(org_id,shift_id) WHERE supersedes_id IS NULL;

CREATE TABLE public.hrm_attendance_event_claims (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 event_id uuid NOT NULL, shift_id uuid NOT NULL, released_at timestamptz, released_by uuid, release_reason text,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,event_id) REFERENCES public.hrm_attendance_events(org_id,id),
 FOREIGN KEY(org_id,shift_id) REFERENCES public.hrm_shifts(org_id,id),
 FOREIGN KEY(org_id,released_by) REFERENCES public.users(org_id,id),
 CHECK((released_at IS NULL AND released_by IS NULL AND release_reason IS NULL) OR (released_at IS NOT NULL AND released_by IS NOT NULL AND length(btrim(release_reason)) BETWEEN 1 AND 2000)),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id)
);

CREATE UNIQUE INDEX hrm_attendance_event_claims_active ON public.hrm_attendance_event_claims(org_id,event_id) WHERE released_at IS NULL;

CREATE TABLE public.hrm_attendance_observation_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 observation_id uuid NOT NULL, event_claim_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,observation_id) REFERENCES public.hrm_attendance_observations(org_id,id),
 FOREIGN KEY(org_id,event_claim_id) REFERENCES public.hrm_attendance_event_claims(org_id,id),
 UNIQUE(org_id,observation_id,event_claim_id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id)
);

-- Attendance bounds are declared, rather than guessed from a device's last event.
CREATE FUNCTION public.hrm_shift_attendance_policy(policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $function$
DECLARE field text;
BEGIN
 IF jsonb_typeof(policy) IS DISTINCT FROM 'object' OR policy-ARRAY['captureBeforeSeconds','captureAfterSeconds','lateGraceSeconds','earlyGraceSeconds']<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH field IN ARRAY ARRAY['captureBeforeSeconds','captureAfterSeconds','lateGraceSeconds','earlyGraceSeconds'] LOOP
  IF jsonb_typeof(policy->field) IS DISTINCT FROM 'number' OR (policy->>field)!~'^[0-9]{1,5}$' OR (policy->>field)::integer>43200 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $function$;

CREATE FUNCTION public.hrm_shift_validate_requirements(tenant uuid, requirements jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE item jsonb; identity uuid; seen uuid[]:=ARRAY[]::uuid[];
BEGIN
 IF jsonb_typeof(requirements) IS DISTINCT FROM 'array' OR jsonb_array_length(requirements)>100 THEN RAISE EXCEPTION 'Shift requirements need at most 100 native qualification types; select the declared types again.'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(requirements) LOOP
  IF jsonb_typeof(item)<>'string' OR (item#>>'{}')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'A shift qualification reference is invalid; select a native qualification type.'; END IF;
  identity:=(item#>>'{}')::uuid;
  IF identity=ANY(seen) THEN RAISE EXCEPTION 'A qualification type appears more than once; keep one requirement for each type.'; END IF;
  PERFORM id FROM public.hrm_qualification_types WHERE org_id=tenant AND id=identity AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'A required qualification type is unavailable; declare or reactivate its native type before publication.'; END IF;
  seen:=array_append(seen,identity);
 END LOOP;
END $function$;

CREATE FUNCTION public.hrm_shift_validate_pattern(tenant uuid, source_id uuid, pattern jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE source public.work_schedules; slot jsonb; cycle integer; position integer; starts integer; ends integer; pause integer;
 intervals int8range[]:=ARRAY[]::int8range[]; segment int8range; existing int8range; cycle_seconds bigint; from_second bigint; to_second bigint;
BEGIN
 SELECT * INTO source FROM public.work_schedules WHERE org_id=tenant AND id=source_id AND is_active FOR SHARE;
 IF NOT FOUND OR source.pattern<>'cycle' THEN RAISE EXCEPTION 'Recurring shifts need an active native repeating work schedule; select a cycle or create individual shifts.'; END IF;
 IF jsonb_typeof(pattern) IS DISTINCT FROM 'object' OR NOT pattern ?& ARRAY['schedule','timeZone','slots'] OR jsonb_typeof(pattern->'schedule') IS DISTINCT FROM 'object'
  OR jsonb_typeof(pattern->'slots') IS DISTINCT FROM 'array' OR jsonb_array_length(pattern->'slots') NOT BETWEEN 1 AND 1000
  OR pattern#>>'{schedule,id}' IS DISTINCT FROM source_id::text OR pattern#>>'{schedule,pattern}' IS DISTINCT FROM 'cycle'
  OR pattern#>>'{schedule,cycleDays}' IS DISTINCT FROM source.cycle_days::text OR pattern#>>'{schedule,cycleAnchor}' IS DISTINCT FROM source.cycle_anchor::text
  OR pattern#>>'{schedule,effectiveFrom}' IS DISTINCT FROM source.effective_from::text OR pattern#>>'{schedule,name}' IS DISTINCT FROM source.name
  OR pattern#>'{schedule,days}' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('dayIndex',day_index,'hours',hours::text) ORDER BY day_index),'[]'::jsonb) FROM public.work_schedule_days WHERE org_id=tenant AND schedule_id=source_id) THEN
  RAISE EXCEPTION 'The recurring definition does not match its native cycle; reload the selected work schedule before authoring.';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=pattern->>'timeZone') THEN RAISE EXCEPTION 'The shift time zone is unknown; select a named time zone.'; END IF;
 cycle:=source.cycle_days; cycle_seconds:=cycle::bigint*86400;
 FOR slot IN SELECT value FROM jsonb_array_elements(pattern->'slots') LOOP
  IF jsonb_typeof(slot) IS DISTINCT FROM 'object' OR NOT slot ?& ARRAY['position','starts','ends','endDayOffset','plannedBreakSeconds','qualificationTypeIds'] OR slot-ARRAY['position','starts','ends','endDayOffset','plannedBreakSeconds','qualificationTypeIds']<>'{}'::jsonb
   OR jsonb_typeof(slot->'position') IS DISTINCT FROM 'number' OR (slot->>'position')!~'^[0-9]{1,3}$'
   OR jsonb_typeof(slot->'endDayOffset') IS DISTINCT FROM 'number' OR (slot->>'endDayOffset') NOT IN ('0','1')
   OR jsonb_typeof(slot->'plannedBreakSeconds') IS DISTINCT FROM 'number' OR (slot->>'plannedBreakSeconds')!~'^[0-9]{1,5}$'
   OR jsonb_typeof(slot->'starts') IS DISTINCT FROM 'string' OR (slot->>'starts')!~'^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
   OR jsonb_typeof(slot->'ends') IS DISTINCT FROM 'string' OR (slot->>'ends')!~'^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$' THEN
   RAISE EXCEPTION 'A recurring slot is incomplete; enter its cycle position, real clock times, next-day setting and planned break.';
  END IF;
  position:=(slot->>'position')::integer; starts:=extract(epoch FROM (slot->>'starts')::time)::integer;
  ends:=extract(epoch FROM (slot->>'ends')::time)::integer+(slot->>'endDayOffset')::integer*86400; pause:=(slot->>'plannedBreakSeconds')::integer;
  IF position>=cycle OR ends<=starts OR ends-starts>86400 OR pause>=ends-starts THEN RAISE EXCEPTION 'A recurring slot is outside its cycle or has no working time; correct the position, times and break.'; END IF;
  PERFORM public.hrm_shift_validate_requirements(tenant,slot->'qualificationTypeIds');
  from_second:=position::bigint*86400+starts; to_second:=position::bigint*86400+ends;
  FOR segment IN SELECT unnest(CASE WHEN to_second>cycle_seconds THEN ARRAY[int8range(from_second,cycle_seconds,'[)'),int8range(0,to_second-cycle_seconds,'[)')] ELSE ARRAY[int8range(from_second,to_second,'[)')] END) LOOP
   FOREACH existing IN ARRAY intervals LOOP
    IF existing && segment THEN RAISE EXCEPTION 'Recurring slots overlap, including at the cycle boundary; adjust their clock times before approval.'; END IF;
   END LOOP;
   intervals:=array_append(intervals,segment);
  END LOOP;
 END LOOP;
END $function$;

CREATE FUNCTION public.hrm_shift_assert_employment(tenant uuid, identity uuid, employer uuid, worker uuid, from_on date, through_on date) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 PERFORM id FROM public.worker_employments WHERE org_id=tenant AND id=identity AND employer_subsidiary_id=employer AND worker_party_id=worker FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'The shift employment is unavailable for this employer and person; select the native employment again.'; END IF;
 IF NOT EXISTS(SELECT employment_id FROM public.worker_employment_versions WHERE org_id=tenant AND employment_id=identity AND recorded_until IS NULL AND status='active'
  GROUP BY employment_id HAVING range_agg(daterange(effective_from,effective_to,'[)')) @> daterange(from_on,through_on,'[]')) THEN
  RAISE EXCEPTION 'Active employment history does not cover the whole shift; choose a covered date or record verified employment history through its native workflow.';
 END IF;
END $function$;

CREATE FUNCTION public.hrm_shift_assert_available(tenant uuid, identity uuid, employer uuid, worker uuid, from_on date, through_on date, requirements jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE requirement jsonb; type_row public.hrm_qualification_types; blocked_date date;
BEGIN
 PERFORM public.hrm_shift_assert_employment(tenant,identity,employer,worker,from_on,through_on);
 SELECT a.on_date INTO blocked_date FROM public.hrm_absences a JOIN public.worker_employments e ON e.org_id=a.org_id AND e.id=a.employment_id
 WHERE a.org_id=tenant AND e.worker_party_id=worker AND a.on_date BETWEEN from_on AND through_on
 GROUP BY a.on_date,a.employment_id,a.leave_type_id HAVING sum(a.hours)<>0 ORDER BY a.on_date LIMIT 1;
 IF FOUND THEN RAISE EXCEPTION 'Recorded leave conflicts with the shift on %; choose another shift date or correct the absence through its native workflow. Partial-day leave has no clock interval and cannot be silently ignored.',blocked_date; END IF;
 PERFORM public.hrm_shift_validate_requirements(tenant,requirements);
 FOR requirement IN SELECT value FROM jsonb_array_elements(requirements) LOOP
  SELECT * INTO type_row FROM public.hrm_qualification_types WHERE org_id=tenant AND id=(requirement#>>'{}')::uuid FOR SHARE;
  PERFORM id FROM public.hrm_worker_qualifications WHERE org_id=tenant AND employment_id=identity AND type_id=type_row.id AND status='valid'
   AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND issued_on<=from_on AND (expires_on IS NULL OR expires_on>=through_on) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift qualification % (%) is not verified for the whole shift; record, renew or verify the matching native qualification before publication.',type_row.name,type_row.code; END IF;
 END LOOP;
END $function$;

CREATE FUNCTION public.hrm_shift_assert_independent(tenant uuid, author_user uuid, author_party uuid, reviewer_user uuid, subject_party uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE author_now uuid; reviewer uuid;
BEGIN
 SELECT party_id INTO author_now FROM public.users WHERE org_id=tenant AND id=author_user FOR SHARE;
 SELECT party_id INTO reviewer FROM public.users WHERE org_id=tenant AND id=reviewer_user AND is_active FOR SHARE;
 IF author_now IS NULL OR reviewer IS NULL OR reviewer_user=author_user OR reviewer IN (author_now,author_party) OR reviewer IS NOT DISTINCT FROM subject_party THEN
  RAISE EXCEPTION 'Shift approval needs an independently identified person; link the approver to their native person and choose someone other than the author or assigned worker.';
 END IF;
END $function$;
CREATE FUNCTION public.hrm_shift_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE template_row public.hrm_shift_templates; assignment_row public.hrm_shift_assignments; publication_row public.hrm_shift_publications;
 shift_row public.hrm_shifts; request_row public.hrm_shift_requests; device_row public.hrm_attendance_devices;
 identity_row public.hrm_attendance_identities; batch_row public.hrm_attendance_batches; event_row public.hrm_attendance_events;
 claim_row public.hrm_attendance_event_claims; observation_row public.hrm_attendance_observations;
 author_person uuid; prior_through timestamptz; policy jsonb; slot jsonb; occurrence_date date; last_date date;
 mutable boolean; allowed_columns text[]; parent_key uuid; features jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Roster and attendance history cannot be deleted; cancel a shift, end an assignment or append a reasoned source correction.';
 END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 mutable:=TG_TABLE_NAME IN ('hrm_shift_templates','hrm_shift_assignments','hrm_shifts','hrm_shift_requests','hrm_attendance_devices','hrm_attendance_identities','hrm_attendance_watermarks');
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.org_id,NEW.created_at,NEW.created_by,NEW.request_hash) IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.created_at,OLD.created_by,OLD.request_hash) THEN
   RAISE EXCEPTION 'Roster ownership and creation evidence are immutable; create a successor record.';
  END IF;
  IF mutable THEN
   IF NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'Roster revision changed; reload the record before saving.'; END IF;
  ELSIF TG_TABLE_NAME<>'hrm_attendance_event_claims' THEN
   RAISE EXCEPTION 'Attendance source and observation evidence is immutable; append a reasoned correction with the previous record as its predecessor.';
  END IF;
 END IF;
 IF TG_TABLE_NAME IN ('hrm_shift_templates','hrm_shift_assignments','hrm_shifts','hrm_shift_requests') AND TG_OP='INSERT' THEN
  SELECT party_id INTO author_person FROM public.users WHERE org_id=NEW.org_id AND id=NEW.created_by AND is_active FOR SHARE;
  IF TG_TABLE_NAME<>'hrm_shifts' OR (to_jsonb(NEW)->>'publication_id' IS NULL AND to_jsonb(NEW)->>'origin_request_id' IS NULL) THEN
   IF author_person IS NULL OR author_person IS DISTINCT FROM NEW.author_party_id THEN RAISE EXCEPTION 'Roster authorship needs a native person identity; link the author to their person record before creating the request.'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME='hrm_shift_templates' THEN
  IF NEW.attendance_policy IS NOT NULL AND NOT public.hrm_shift_attendance_policy(NEW.attendance_policy) THEN RAISE EXCEPTION 'Attendance capture and grace bounds are incomplete; declare all four whole-second bounds before saving.'; END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Create a recurring definition draft before independent approval.'; END IF;
   PERFORM public.hrm_shift_validate_pattern(NEW.org_id,NEW.normal_work_schedule_id,NEW.pattern);
   IF EXISTS(SELECT 1 FROM public.work_schedules s WHERE s.org_id=NEW.org_id AND s.id=NEW.normal_work_schedule_id
    AND ((s.subsidiary_id IS NOT NULL AND s.subsidiary_id<>NEW.subsidiary_id) OR (s.employee_party_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.worker_employments e WHERE e.org_id=s.org_id AND e.worker_party_id=s.employee_party_id AND e.employer_subsidiary_id=NEW.subsidiary_id)))) THEN
    RAISE EXCEPTION 'The normal work cycle belongs to another employer; select a cycle in the recurring definition employer scope.';
   END IF;
  ELSE
   allowed_columns:=ARRAY['status','decided_by','decided_at','revision','reason','updated_at','updated_by'];
   IF to_jsonb(NEW)-allowed_columns IS DISTINCT FROM to_jsonb(OLD)-allowed_columns THEN RAISE EXCEPTION 'A recurring definition is immutable; create an effective-dated successor version.'; END IF;
   IF NOT ((OLD.status='draft' AND NEW.status IN ('approved','cancelled')) OR (OLD.status='approved' AND NEW.status='retired')) THEN RAISE EXCEPTION 'This recurring definition transition is unavailable; reload and choose an action for its current state.'; END IF;
   IF NEW.status='approved' THEN
    PERFORM public.hrm_shift_validate_pattern(NEW.org_id,NEW.normal_work_schedule_id,NEW.pattern);
    PERFORM public.hrm_shift_assert_independent(NEW.org_id,NEW.created_by,NEW.author_party_id,NEW.updated_by);
    IF NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN RAISE EXCEPTION 'Approval evidence does not name this reviewer; use the native approval action.'; END IF;
   ELSIF ROW(NEW.decided_by,NEW.decided_at) IS DISTINCT FROM ROW(OLD.decided_by,OLD.decided_at) THEN RAISE EXCEPTION 'Recurring approval evidence is immutable; retain the original decision.'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_shift_assignments' THEN
  PERFORM id FROM public.worker_employments WHERE org_id=NEW.org_id AND id=NEW.employment_id FOR UPDATE;
  SELECT * INTO template_row FROM public.hrm_shift_templates WHERE org_id=NEW.org_id AND id=NEW.template_id FOR SHARE;
  IF NOT FOUND OR template_row.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id THEN RAISE EXCEPTION 'The recurring definition is unavailable for this employer; select a matching approved version.'; END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'draft' OR template_row.status<>'approved' THEN RAISE EXCEPTION 'Create an assignment draft against an approved recurring definition.'; END IF;
  ELSE
   allowed_columns:=ARRAY['status','effective_to','decided_by','decided_at','revision','reason','updated_at','updated_by'];
   IF to_jsonb(NEW)-allowed_columns IS DISTINCT FROM to_jsonb(OLD)-allowed_columns THEN RAISE EXCEPTION 'Assignment ownership and start are immutable; end it and create a successor assignment.'; END IF;
   IF NOT ((OLD.status='draft' AND NEW.status IN ('approved','cancelled')) OR (OLD.status='approved' AND NEW.status='ended')) THEN RAISE EXCEPTION 'This assignment transition is unavailable; reload and choose an action for its current state.'; END IF;
   IF NEW.status='approved' THEN
    IF template_row.status<>'approved' OR NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN RAISE EXCEPTION 'Assignment approval needs its unchanged draft and an approved definition; create a successor draft for changed dates.'; END IF;
    PERFORM public.hrm_shift_assert_independent(NEW.org_id,NEW.created_by,NEW.author_party_id,NEW.updated_by,NEW.worker_party_id);
    IF NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN RAISE EXCEPTION 'Assignment approval evidence does not name this reviewer; use the native approval action.'; END IF;
   ELSE
    IF ROW(NEW.decided_by,NEW.decided_at) IS DISTINCT FROM ROW(OLD.decided_by,OLD.decided_at) THEN RAISE EXCEPTION 'Assignment approval evidence is immutable; retain the original decision.'; END IF;
    IF NEW.status='ended' THEN
     IF NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to>OLD.effective_to) THEN RAISE EXCEPTION 'Ending an assignment needs an exclusive end within its approved window; choose a covered end date.'; END IF;
     IF EXISTS(SELECT 1 FROM public.hrm_shifts s JOIN public.hrm_shift_publications p ON p.org_id=s.org_id AND p.id=s.publication_id WHERE p.org_id=NEW.org_id AND p.assignment_id=NEW.id AND s.status IN ('published','closed') AND ((s.ends_at-interval '1 millisecond') AT TIME ZONE s.time_zone)::date>=NEW.effective_to) THEN RAISE EXCEPTION 'The assignment has a live published shift at or after this end; cancel affected future shifts before ending it, preserving closed shift history.'; END IF;
    ELSIF NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN RAISE EXCEPTION 'Cancellation cannot rewrite assignment dates; retain its original draft evidence.'; END IF;
   END IF;
  END IF;
  IF NEW.effective_from<template_row.effective_from OR (template_row.effective_to IS NOT NULL AND (NEW.effective_to IS NULL OR NEW.effective_to>template_row.effective_to)) THEN RAISE EXCEPTION 'Assignment dates exceed the recurring definition window; choose a matching effective-dated version.'; END IF;
 ELSIF TG_TABLE_NAME='hrm_shift_publications' THEN
  SELECT * INTO assignment_row FROM public.hrm_shift_assignments WHERE org_id=NEW.org_id AND id=NEW.assignment_id FOR UPDATE;
  SELECT * INTO template_row FROM public.hrm_shift_templates WHERE org_id=NEW.org_id AND id=assignment_row.template_id FOR SHARE;
  IF assignment_row.status IS DISTINCT FROM 'approved' OR template_row.status IS DISTINCT FROM 'approved' OR NEW.assignment_revision IS DISTINCT FROM assignment_row.revision
   OR NEW.definition_hash IS DISTINCT FROM template_row.definition_hash OR NEW.from_on<assignment_row.effective_from OR (assignment_row.effective_to IS NOT NULL AND NEW.through_on>=assignment_row.effective_to) THEN
   RAISE EXCEPTION 'The publication does not match its approved assignment window and revision; reload the assignment and choose a covered calendar.';
  END IF;
 ELSIF TG_TABLE_NAME='hrm_shifts' THEN
  IF NEW.attendance_policy IS NOT NULL AND NOT public.hrm_shift_attendance_policy(NEW.attendance_policy) THEN RAISE EXCEPTION 'Attendance capture and grace bounds are incomplete; declare all four whole-second bounds before saving.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.time_zone) OR NEW.starts_on<>(NEW.starts_at AT TIME ZONE NEW.time_zone)::date OR NEW.ends_on<>(NEW.ends_at AT TIME ZONE NEW.time_zone)::date THEN RAISE EXCEPTION 'Shift dates do not match their time zone; select the exact clock-time occurrences again.'; END IF;
  last_date:=((NEW.ends_at-interval '1 millisecond') AT TIME ZONE NEW.time_zone)::date;
  IF TG_OP='INSERT' THEN
   IF NEW.publication_id IS NOT NULL THEN
    SELECT * INTO publication_row FROM public.hrm_shift_publications WHERE org_id=NEW.org_id AND id=NEW.publication_id FOR SHARE;
    SELECT * INTO assignment_row FROM public.hrm_shift_assignments WHERE org_id=NEW.org_id AND id=publication_row.assignment_id FOR SHARE;
    SELECT * INTO template_row FROM public.hrm_shift_templates WHERE org_id=NEW.org_id AND id=assignment_row.template_id FOR SHARE;
    slot:=template_row.pattern->'slots'->NEW.slot_index;
    IF NEW.status<>'published' OR assignment_row.status IS DISTINCT FROM 'approved' OR NEW.template_id IS DISTINCT FROM template_row.id OR NEW.employment_id IS DISTINCT FROM assignment_row.employment_id
     OR NEW.subsidiary_id IS DISTINCT FROM assignment_row.subsidiary_id OR NEW.worker_party_id IS DISTINCT FROM assignment_row.worker_party_id
     OR NEW.author_party_id IS DISTINCT FROM assignment_row.author_party_id OR NEW.decided_by IS DISTINCT FROM assignment_row.decided_by OR NEW.decided_at IS DISTINCT FROM assignment_row.decided_at
     OR NEW.starts_on NOT BETWEEN publication_row.from_on AND publication_row.through_on OR NEW.definition_hash IS DISTINCT FROM template_row.definition_hash
     OR NEW.attendance_policy IS DISTINCT FROM template_row.attendance_policy OR NEW.time_zone IS DISTINCT FROM template_row.pattern->>'timeZone' OR slot IS NULL
     OR ((NEW.starts_on-(template_row.pattern#>>'{schedule,cycleAnchor}')::date)%(template_row.pattern#>>'{schedule,cycleDays}')::integer+(template_row.pattern#>>'{schedule,cycleDays}')::integer)%(template_row.pattern#>>'{schedule,cycleDays}')::integer<>(slot->>'position')::integer
     OR (NEW.starts_at AT TIME ZONE NEW.time_zone)::time<>(slot->>'starts')::time OR (NEW.ends_at AT TIME ZONE NEW.time_zone)::time<>(slot->>'ends')::time
     OR NEW.ends_on-NEW.starts_on<>(slot->>'endDayOffset')::integer OR NEW.planned_break_seconds<>(slot->>'plannedBreakSeconds')::integer OR NEW.qualification_type_ids IS DISTINCT FROM slot->'qualificationTypeIds' THEN
     RAISE EXCEPTION 'The published shift differs from its approved recurring slot; regenerate it from the approved publication.';
    END IF;
    IF assignment_row.effective_to IS NOT NULL AND last_date>=assignment_row.effective_to THEN RAISE EXCEPTION 'The shift extends beyond its approved assignment; shorten the publication or use the successor assignment.'; END IF;
   ELSIF NEW.origin_request_id IS NOT NULL THEN
    SELECT * INTO request_row FROM public.hrm_shift_requests WHERE org_id=NEW.org_id AND id=NEW.origin_request_id FOR UPDATE;
    SELECT * INTO shift_row FROM public.hrm_shifts WHERE org_id=NEW.org_id AND id=request_row.shift_id FOR SHARE;
    IF request_row.kind IS DISTINCT FROM 'change' OR request_row.status NOT IN ('pending','approved') OR NEW.status<>'published'
     OR NEW.employment_id IS DISTINCT FROM request_row.employment_id OR NEW.supersedes_id IS DISTINCT FROM request_row.shift_id
     OR NEW.starts_at IS DISTINCT FROM request_row.proposed_starts_at OR NEW.ends_at IS DISTINCT FROM request_row.proposed_ends_at
     OR NEW.author_party_id IS DISTINCT FROM request_row.author_party_id OR NEW.decided_by IS DISTINCT FROM NEW.created_by
     OR ROW(NEW.name,NEW.time_zone,NEW.planned_break_seconds,NEW.qualification_type_ids,NEW.attendance_policy)
      IS DISTINCT FROM ROW(shift_row.name,shift_row.time_zone,shift_row.planned_break_seconds,shift_row.qualification_type_ids,shift_row.attendance_policy) THEN RAISE EXCEPTION 'The replacement does not match its employee change request; review and apply the unchanged request atomically.'; END IF;
    PERFORM public.hrm_shift_assert_independent(NEW.org_id,request_row.created_by,request_row.author_party_id,NEW.created_by,NEW.worker_party_id);
   ELSIF NEW.status<>'draft' OR NEW.decided_by IS NOT NULL THEN RAISE EXCEPTION 'Create an individual shift draft before independent publication.';
   END IF;
  ELSE
   allowed_columns:=ARRAY['status','decided_by','decided_at','revision','reason','updated_at','updated_by'];
   IF to_jsonb(NEW)-allowed_columns IS DISTINCT FROM to_jsonb(OLD)-allowed_columns THEN RAISE EXCEPTION 'Shift times and requirements are immutable; cancel the shift and publish a corrected successor.'; END IF;
   IF NOT ((OLD.status='draft' AND NEW.status IN ('published','cancelled')) OR (OLD.status='published' AND NEW.status IN ('closed','cancelled'))) THEN RAISE EXCEPTION 'This shift transition is unavailable; reload and choose an action for its current state.'; END IF;
   IF NEW.status='published' THEN
    PERFORM public.hrm_shift_assert_independent(NEW.org_id,NEW.created_by,NEW.author_party_id,NEW.updated_by,NEW.worker_party_id);
    IF NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN RAISE EXCEPTION 'Publication evidence does not name this reviewer; use the native publication action.'; END IF;
   ELSIF ROW(NEW.decided_by,NEW.decided_at) IS DISTINCT FROM ROW(OLD.decided_by,OLD.decided_at) THEN RAISE EXCEPTION 'Shift publication evidence is immutable; retain the original decision.'; END IF;
   IF NEW.status='closed' THEN
    SELECT settings->'features' INTO features FROM public.orgs WHERE id=NEW.org_id FOR SHARE;
    IF features->'hrm' IS DISTINCT FROM 'true'::jsonb OR features->'hrmShiftPlanning' IS DISTINCT FROM 'true'::jsonb
     OR features->'hrmAttendance' IS DISTINCT FROM 'true'::jsonb OR features->'hrmShiftClosing' IS DISTINCT FROM 'true'::jsonb THEN
     RAISE EXCEPTION 'Formal shift closing is disabled; enable its optional capability and dependencies on Company Settings → Features. Published shifts do not require closing.';
    END IF;
   END IF;
   IF NEW.status='closed' AND (NEW.ends_at>now() OR NOT EXISTS(SELECT 1 FROM public.hrm_attendance_observations o WHERE o.org_id=NEW.org_id AND o.shift_id=NEW.id AND o.status IN ('absent','present') AND NOT EXISTS(SELECT 1 FROM public.hrm_attendance_observations n WHERE n.org_id=o.org_id AND n.supersedes_id=o.id))) THEN RAISE EXCEPTION 'Attendance is not complete for this ended shift; finish source synchronization and process attendance before closing it.'; END IF;
   IF NEW.status='closed' THEN PERFORM public.hrm_shift_assert_attendance_current(NEW.org_id,NEW.id); END IF;
  END IF;
  IF NEW.status='published' THEN
   PERFORM public.hrm_shift_assert_available(NEW.org_id,NEW.employment_id,NEW.subsidiary_id,NEW.worker_party_id,NEW.starts_on,last_date,NEW.qualification_type_ids);
  ELSIF TG_OP='INSERT' THEN
   PERFORM public.hrm_shift_assert_employment(NEW.org_id,NEW.employment_id,NEW.subsidiary_id,NEW.worker_party_id,NEW.starts_on,last_date);
   PERFORM public.hrm_shift_validate_requirements(NEW.org_id,NEW.qualification_type_ids);
  END IF;
 ELSIF TG_TABLE_NAME='hrm_shift_requests' THEN
  SELECT * INTO shift_row FROM public.hrm_shifts WHERE org_id=NEW.org_id AND id=NEW.shift_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'pending' OR shift_row.status IS DISTINCT FROM 'published' OR NEW.shift_revision IS DISTINCT FROM shift_row.revision
    OR ROW(NEW.employment_id,NEW.subsidiary_id,NEW.worker_party_id) IS DISTINCT FROM ROW(shift_row.employment_id,shift_row.subsidiary_id,shift_row.worker_party_id) THEN RAISE EXCEPTION 'The request does not match a published shift revision; reload the shift before requesting a change.'; END IF;
  ELSE
   allowed_columns:=ARRAY['status','outcome_shift_id','decided_by','decided_at','revision','reason','updated_at','updated_by'];
   IF to_jsonb(NEW)-allowed_columns IS DISTINCT FROM to_jsonb(OLD)-allowed_columns OR OLD.status<>'pending' OR NEW.status NOT IN ('approved','declined','withdrawn') THEN RAISE EXCEPTION 'Shift request details are immutable; withdraw it and create a corrected request.'; END IF;
   IF NEW.status IN ('approved','declined') THEN
    PERFORM public.hrm_shift_assert_independent(NEW.org_id,NEW.created_by,NEW.author_party_id,NEW.updated_by,NEW.worker_party_id);
    IF NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN RAISE EXCEPTION 'Request decision evidence does not name this reviewer; use the native review action.'; END IF;
   ELSIF NEW.updated_by<>NEW.created_by THEN RAISE EXCEPTION 'Only the request author can withdraw it; ask its author or decline it with an independent decision.'; END IF;
   IF NEW.status='approved' AND (shift_row.status<>'cancelled' OR shift_row.revision<>NEW.shift_revision+1 OR (NEW.kind='change' AND NEW.outcome_shift_id IS NULL)) THEN RAISE EXCEPTION 'An approved request needs its atomic roster outcome; cancel the original and publish the requested replacement in the same command.'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_devices' THEN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.time_zone) THEN RAISE EXCEPTION 'The attendance device time zone is unknown; select its named source time zone.'; END IF;
  IF TG_OP='UPDATE' AND to_jsonb(NEW)-ARRAY['name','is_active','revision','reason','updated_at','updated_by'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['name','is_active','revision','reason','updated_at','updated_by'] THEN RAISE EXCEPTION 'A device identity, employer and time zone are immutable; register a successor device for a changed source.'; END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_identities' THEN
  SELECT * INTO device_row FROM public.hrm_attendance_devices WHERE org_id=NEW.org_id AND id=NEW.device_id FOR UPDATE;
  IF TG_OP='INSERT' AND (NOT device_row.is_active OR device_row.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id) THEN RAISE EXCEPTION 'The device is unavailable for this employer; choose an active employer device.'; END IF;
  IF TG_OP='UPDATE' THEN
   IF to_jsonb(NEW)-ARRAY['effective_to','revision','reason','updated_at','updated_by'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['effective_to','revision','reason','updated_at','updated_by']
    OR NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to>OLD.effective_to) THEN RAISE EXCEPTION 'Device identity mapping is immutable; close its interval and create a verified successor mapping.'; END IF;
   IF EXISTS(SELECT 1 FROM public.hrm_attendance_events WHERE org_id=NEW.org_id AND identity_id=NEW.id AND source_local_date>=NEW.effective_to) THEN RAISE EXCEPTION 'Recorded device events extend beyond this mapping end; preserve their identity interval and choose a later exclusive end.'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_batches' THEN
  SELECT * INTO device_row FROM public.hrm_attendance_devices WHERE org_id=NEW.org_id AND id=NEW.device_id FOR UPDATE;
  IF NOT FOUND OR NOT device_row.is_active THEN RAISE EXCEPTION 'The attendance device is unavailable; reactivate its native record before admitting a source batch.'; END IF;
  IF NEW.source_evidence->>'source' IS NULL OR length(btrim(NEW.source_evidence->>'source'))=0 THEN RAISE EXCEPTION 'Attendance batch source evidence is missing; identify the actual source or import file before admission.'; END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_events' THEN
  SELECT * INTO device_row FROM public.hrm_attendance_devices WHERE org_id=NEW.org_id AND id=NEW.device_id FOR UPDATE;
  SELECT * INTO batch_row FROM public.hrm_attendance_batches WHERE org_id=NEW.org_id AND id=NEW.batch_id;
  SELECT * INTO identity_row FROM public.hrm_attendance_identities WHERE org_id=NEW.org_id AND id=NEW.identity_id FOR SHARE;
  IF ROW(NEW.subsidiary_id,NEW.employment_id,NEW.worker_party_id) IS DISTINCT FROM ROW(identity_row.subsidiary_id,identity_row.employment_id,identity_row.worker_party_id)
   OR NEW.source_local_date<>(NEW.occurred_at AT TIME ZONE device_row.time_zone)::date OR NEW.source_local_date<identity_row.effective_from OR (identity_row.effective_to IS NOT NULL AND NEW.source_local_date>=identity_row.effective_to) THEN
   RAISE EXCEPTION 'The check-in does not match its dated native device identity; reconcile the employee mapping and source local date before admission.';
  END IF;
  SELECT complete_through INTO prior_through FROM public.hrm_attendance_watermarks WHERE org_id=NEW.org_id AND device_id=NEW.device_id FOR SHARE;
  IF (NEW.occurred_at<=prior_through OR NEW.supersedes_id IS NOT NULL) AND batch_row.source_evidence->'correction' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'This event changes source records already declared complete; admit an explicit reasoned correction batch and reprocess affected attendance.'; END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
   SELECT * INTO event_row FROM public.hrm_attendance_events WHERE org_id=NEW.org_id AND id=NEW.supersedes_id FOR SHARE;
   IF NEW.source_version IS DISTINCT FROM event_row.source_version+1 OR NEW.source_event_id IS DISTINCT FROM event_row.source_event_id OR NEW.device_id IS DISTINCT FROM event_row.device_id THEN RAISE EXCEPTION 'The event correction does not name the next source version; append a correction to its actual latest predecessor.'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_watermarks' THEN
  SELECT * INTO device_row FROM public.hrm_attendance_devices WHERE org_id=NEW.org_id AND id=NEW.device_id FOR UPDATE;
  SELECT * INTO batch_row FROM public.hrm_attendance_batches WHERE org_id=NEW.org_id AND id=NEW.batch_id;
  IF NEW.complete_through IS DISTINCT FROM batch_row.complete_through THEN RAISE EXCEPTION 'The completeness watermark differs from its admitted source batch; use the source-declared completeness instant.'; END IF;
  IF TG_OP='UPDATE' AND (NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.complete_through<OLD.complete_through) THEN RAISE EXCEPTION 'Device completeness cannot move backwards; retain the watermark and admit a reasoned correction batch.'; END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_observations' THEN
  SELECT * INTO shift_row FROM public.hrm_shifts WHERE org_id=NEW.org_id AND id=NEW.shift_id FOR UPDATE;
  IF shift_row.attendance_policy IS NULL AND NEW.status<>'voided' THEN RAISE EXCEPTION 'The shift has no attendance capture policy; publish a successor with explicit capture and grace bounds before processing attendance. Ordinary scheduling needs no attendance policy.'; END IF;
  IF shift_row.status NOT IN ('published','closed','cancelled') OR ROW(NEW.subsidiary_id,NEW.employment_id,NEW.worker_party_id) IS DISTINCT FROM ROW(shift_row.subsidiary_id,shift_row.employment_id,shift_row.worker_party_id) THEN RAISE EXCEPTION 'Attendance requires a published native shift and its exact employment; reload the roster shift.'; END IF;
  IF (shift_row.status='cancelled')<>(NEW.status='voided') THEN RAISE EXCEPTION 'Cancelled shifts need voided attendance evidence; process the current roster state without deleting earlier observations.'; END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
   SELECT * INTO observation_row FROM public.hrm_attendance_observations WHERE org_id=NEW.org_id AND id=NEW.supersedes_id FOR SHARE;
   IF observation_row.shift_id IS DISTINCT FROM NEW.shift_id THEN RAISE EXCEPTION 'Attendance correction belongs to another shift; use this shift latest observation as predecessor.'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_event_claims' THEN
  SELECT * INTO event_row FROM public.hrm_attendance_events WHERE org_id=NEW.org_id AND id=NEW.event_id FOR UPDATE;
  SELECT * INTO shift_row FROM public.hrm_shifts WHERE org_id=NEW.org_id AND id=NEW.shift_id FOR SHARE;
  IF TG_OP='UPDATE' THEN
   IF to_jsonb(NEW)-ARRAY['released_at','released_by','release_reason'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['released_at','released_by','release_reason'] OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN RAISE EXCEPTION 'Attendance attribution is immutable; release an active claim once with its actor and reason.'; END IF;
  ELSE
   IF NEW.released_at IS NOT NULL OR event_row.kind='void' OR event_row.employment_id IS DISTINCT FROM shift_row.employment_id OR event_row.worker_party_id IS DISTINCT FROM shift_row.worker_party_id OR shift_row.status NOT IN ('published','closed')
    OR EXISTS(SELECT 1 FROM public.hrm_attendance_events WHERE org_id=NEW.org_id AND supersedes_id=NEW.event_id)
    OR event_row.occurred_at<shift_row.starts_at-make_interval(secs=>(shift_row.attendance_policy->>'captureBeforeSeconds')::integer)
    OR event_row.occurred_at>shift_row.ends_at+make_interval(secs=>(shift_row.attendance_policy->>'captureAfterSeconds')::integer) THEN
    RAISE EXCEPTION 'The check-in cannot be attributed to this shift; reconcile its current source version, employment and capture window.';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_observation_events' THEN
  SELECT * INTO observation_row FROM public.hrm_attendance_observations WHERE org_id=NEW.org_id AND id=NEW.observation_id FOR SHARE;
  SELECT * INTO claim_row FROM public.hrm_attendance_event_claims WHERE org_id=NEW.org_id AND id=NEW.event_claim_id FOR SHARE;
  IF claim_row.shift_id IS DISTINCT FROM observation_row.shift_id OR claim_row.released_at IS NOT NULL OR NEW.created_by IS DISTINCT FROM observation_row.created_by THEN RAISE EXCEPTION 'Observation evidence does not match its active shift attribution; process the shift source records atomically.'; END IF;
 END IF;
 RETURN NEW;
END $function$;
-- Validate complete command results after every row in an atomic batch exists.
CREATE FUNCTION public.hrm_shift_evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE shift_row public.hrm_shifts; request_row public.hrm_shift_requests; observation_row public.hrm_attendance_observations;
 batch_row public.hrm_attendance_batches; event_row record; device_count integer; incomplete_count integer; effective_through timestamptz;
 assignment_row public.hrm_shift_assignments; template_row public.hrm_shift_templates; publication_row public.hrm_shift_publications;
 declared_slot record; selection jsonb; occurrence_key text; consumed_keys text[]:=ARRAY[]::text[]; required_count integer:=0;
 capture_from timestamptz; capture_to timestamptz; expected_ids uuid[]; linked_ids uuid[]; state text:='out'; opened_at timestamptz;
 break_at timestamptz; first_at timestamptz; last_at timestamptz; previous_at timestamptz; presence bigint:=0; breaks bigint:=0;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='hrm_shift_publications' THEN
  SELECT * INTO publication_row FROM public.hrm_shift_publications WHERE org_id=NEW.org_id AND id=NEW.id;
  SELECT * INTO assignment_row FROM public.hrm_shift_assignments WHERE org_id=NEW.org_id AND id=publication_row.assignment_id;
  SELECT * INTO template_row FROM public.hrm_shift_templates WHERE org_id=NEW.org_id AND id=assignment_row.template_id;
  FOR declared_slot IN SELECT day::date as on_date,slot.value,slot.ordinality-1 as slot_index FROM generate_series(publication_row.from_on::timestamp,publication_row.through_on::timestamp,interval '1 day') day
   CROSS JOIN jsonb_array_elements(template_row.pattern->'slots') WITH ORDINALITY slot(value,ordinality)
   WHERE (((day::date-(template_row.pattern#>>'{schedule,cycleAnchor}')::date)%(template_row.pattern#>>'{schedule,cycleDays}')::integer)+(template_row.pattern#>>'{schedule,cycleDays}')::integer)%(template_row.pattern#>>'{schedule,cycleDays}')::integer=(slot.value->>'position')::integer LOOP
   occurrence_key:=declared_slot.on_date::text||':'||declared_slot.slot_index::text;
   selection:=publication_row.occurrence_selections->occurrence_key; consumed_keys:=array_append(consumed_keys,occurrence_key);
   IF selection ? 'omitReason' THEN
    IF jsonb_typeof(selection->'omitReason') IS DISTINCT FROM 'string' OR length(btrim(selection->>'omitReason')) NOT BETWEEN 1 AND 2000 OR selection ?| ARRAY['startsAt','endsAt'] THEN RAISE EXCEPTION 'An omitted occurrence needs an explicit reason and no selected instants; review its publication decision.'; END IF;
   ELSE
    required_count:=required_count+1;
    IF required_count>10000 THEN RAISE EXCEPTION 'Publication exceeds 10000 shifts; choose a shorter calendar window.'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.hrm_shifts WHERE org_id=NEW.org_id AND publication_id=NEW.id AND starts_on=declared_slot.on_date AND slot_index=declared_slot.slot_index) THEN RAISE EXCEPTION 'The recurring publication is incomplete; publish every approved working slot or retain an explicit reason for its omission.'; END IF;
   END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(publication_row.occurrence_selections) AS choices(key) WHERE NOT choices.key=ANY(consumed_keys)) OR required_count<>(SELECT count(*) FROM public.hrm_shifts WHERE org_id=NEW.org_id AND publication_id=NEW.id) THEN RAISE EXCEPTION 'Publication choices do not match its actual recurring slots; regenerate its native calendar preview.'; END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_batches' THEN
  SELECT * INTO batch_row FROM public.hrm_attendance_batches WHERE org_id=NEW.org_id AND id=NEW.id;
  IF batch_row.event_count<>(SELECT count(*) FROM public.hrm_attendance_events WHERE org_id=NEW.org_id AND batch_id=NEW.id) THEN RAISE EXCEPTION 'The admitted source batch is incomplete; save all declared events and its completeness watermark in one command.'; END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_events' THEN
  IF NEW.supersedes_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.hrm_attendance_event_claims WHERE org_id=NEW.org_id AND event_id=NEW.supersedes_id AND released_at IS NULL) THEN RAISE EXCEPTION 'The corrected event still has active attendance attribution; release its former claim with the same correction reason and reprocess the affected shift.'; END IF;
 ELSIF TG_TABLE_NAME IN ('hrm_shift_requests','hrm_shifts') THEN
  IF TG_TABLE_NAME='hrm_shifts' THEN
   IF NEW.origin_request_id IS NULL THEN RETURN NULL; END IF;
   SELECT * INTO request_row FROM public.hrm_shift_requests WHERE org_id=NEW.org_id AND id=NEW.origin_request_id;
  ELSE
   SELECT * INTO request_row FROM public.hrm_shift_requests WHERE org_id=NEW.org_id AND id=NEW.id;
  END IF;
  IF request_row.status='approved' AND request_row.kind='change' THEN
   SELECT * INTO shift_row FROM public.hrm_shifts WHERE org_id=NEW.org_id AND id=request_row.outcome_shift_id;
   IF shift_row.origin_request_id IS DISTINCT FROM request_row.id OR shift_row.status IS DISTINCT FROM 'published'
    OR shift_row.supersedes_id IS DISTINCT FROM request_row.shift_id OR shift_row.starts_at IS DISTINCT FROM request_row.proposed_starts_at OR shift_row.ends_at IS DISTINCT FROM request_row.proposed_ends_at THEN RAISE EXCEPTION 'The approved change has no matching published successor; apply its original cancellation and exact replacement atomically.'; END IF;
  ELSIF TG_TABLE_NAME='hrm_shifts' AND NEW.origin_request_id IS NOT NULL THEN RAISE EXCEPTION 'The requested replacement has no approved decision; approve its native change request in the same command.';
  END IF;
 ELSIF TG_TABLE_NAME='hrm_attendance_observations' THEN
  SELECT * INTO observation_row FROM public.hrm_attendance_observations WHERE org_id=NEW.org_id AND id=NEW.id;
  SELECT * INTO shift_row FROM public.hrm_shifts WHERE org_id=NEW.org_id AND id=observation_row.shift_id;
  IF observation_row.status='voided' THEN RETURN NULL; END IF;
  capture_from:=shift_row.starts_at-make_interval(secs=>(shift_row.attendance_policy->>'captureBeforeSeconds')::integer);
  capture_to:=shift_row.ends_at+make_interval(secs=>(shift_row.attendance_policy->>'captureAfterSeconds')::integer);
  IF EXISTS(SELECT 1 FROM public.hrm_attendance_identities i JOIN public.hrm_attendance_devices d ON d.org_id=i.org_id AND d.id=i.device_id
   WHERE i.org_id=NEW.org_id AND i.employment_id=shift_row.employment_id
    AND daterange(i.effective_from,i.effective_to,'[)') && daterange((capture_from AT TIME ZONE d.time_zone)::date,(capture_to AT TIME ZONE d.time_zone)::date,'[]')
    AND NOT daterange(i.effective_from,i.effective_to,'[)') @> daterange((capture_from AT TIME ZONE d.time_zone)::date,(capture_to AT TIME ZONE d.time_zone)::date,'[]')) THEN
   RAISE EXCEPTION 'A device identity changes inside the shift capture window; reconcile its dated source mapping before attendance processing.';
  END IF;
  SELECT count(DISTINCT i.device_id),count(*) FILTER(WHERE w.complete_through IS NULL),min(w.complete_through) INTO device_count,incomplete_count,effective_through
  FROM public.hrm_attendance_identities i JOIN public.hrm_attendance_devices d ON d.org_id=i.org_id AND d.id=i.device_id
   LEFT JOIN public.hrm_attendance_watermarks w ON w.org_id=i.org_id AND w.device_id=i.device_id
  WHERE i.org_id=NEW.org_id AND i.employment_id=shift_row.employment_id AND i.worker_party_id=shift_row.worker_party_id
   AND i.effective_from<=(capture_from AT TIME ZONE d.time_zone)::date AND (i.effective_to IS NULL OR i.effective_to>(capture_to AT TIME ZONE d.time_zone)::date);
  IF device_count=0 THEN RAISE EXCEPTION 'No dated attendance source covers this shift capture window; configure its native device identifier before processing attendance.'; END IF;
  IF incomplete_count>0 THEN effective_through:=NULL; END IF;
  IF observation_row.complete_through IS DISTINCT FROM effective_through THEN RAISE EXCEPTION 'Attendance completeness changed; reload all mapped device watermarks and reprocess the shift.'; END IF;
  SELECT coalesce(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[]) INTO expected_ids FROM public.hrm_attendance_events e
  WHERE e.org_id=NEW.org_id AND e.employment_id=shift_row.employment_id AND e.worker_party_id=shift_row.worker_party_id AND e.occurred_at BETWEEN capture_from AND capture_to AND e.kind<>'void'
   AND NOT EXISTS(SELECT 1 FROM public.hrm_attendance_events n WHERE n.org_id=e.org_id AND n.supersedes_id=e.id);
  SELECT coalesce(array_agg(c.event_id ORDER BY c.event_id),ARRAY[]::uuid[]) INTO linked_ids FROM public.hrm_attendance_observation_events oe
   JOIN public.hrm_attendance_event_claims c ON c.org_id=oe.org_id AND c.id=oe.event_claim_id WHERE oe.org_id=NEW.org_id AND oe.observation_id=NEW.id AND c.released_at IS NULL;
  IF expected_ids IS DISTINCT FROM linked_ids THEN RAISE EXCEPTION 'Attendance does not retain every current check-in in its capture window; reconcile ambiguous shift attribution and process the complete source set.'; END IF;
  IF effective_through IS NULL OR effective_through<capture_to THEN
   IF observation_row.status<>'waiting_for_sync' THEN RAISE EXCEPTION 'The mapped device sources have not declared the full capture window complete; wait for synchronization before finalizing attendance.'; END IF;
   RETURN NULL;
  END IF;
  IF cardinality(expected_ids)=0 THEN
   IF observation_row.status<>'absent' THEN RAISE EXCEPTION 'Complete sources contain no check-ins for this shift; record absent attendance without manufacturing a presence interval.'; END IF;
   RETURN NULL;
  END IF;
  FOR event_row IN SELECT id,kind,occurred_at FROM public.hrm_attendance_events WHERE org_id=NEW.org_id AND id=ANY(expected_ids) ORDER BY occurred_at,id LOOP
   IF previous_at IS NOT NULL AND event_row.occurred_at<=previous_at THEN RAISE EXCEPTION 'Check-ins have indistinguishable chronology; reconcile the actual source instants before attendance processing.'; END IF;
   IF state='out' AND event_row.kind='clock_in' THEN
    opened_at:=event_row.occurred_at; first_at:=coalesce(first_at,event_row.occurred_at); state:='in';
   ELSIF state='in' AND event_row.kind='break_start' THEN break_at:=event_row.occurred_at; state:='break';
   ELSIF state='break' AND event_row.kind='break_end' THEN breaks:=breaks+extract(epoch FROM event_row.occurred_at-break_at)*1000; state:='in';
   ELSIF state='in' AND event_row.kind='clock_out' THEN presence:=presence+extract(epoch FROM event_row.occurred_at-opened_at)*1000; last_at:=event_row.occurred_at; state:='out';
   ELSE RAISE EXCEPTION 'Finalized device records contain an inconsistent clock pair; reconcile the missing or contradictory source event before attendance processing.';
   END IF;
   previous_at:=event_row.occurred_at;
  END LOOP;
  IF state<>'out' THEN RAISE EXCEPTION 'Finalized device records leave an unfinished clock or break pair; reconcile the missing source event before attendance processing.'; END IF;
  IF observation_row.status<>'present' OR observation_row.first_in IS DISTINCT FROM first_at OR observation_row.last_out IS DISTINCT FROM last_at
   OR observation_row.presence_milliseconds IS DISTINCT FROM presence-breaks OR observation_row.break_milliseconds IS DISTINCT FROM breaks
   OR observation_row.late IS DISTINCT FROM (first_at>shift_row.starts_at+make_interval(secs=>(shift_row.attendance_policy->>'lateGraceSeconds')::integer))
   OR observation_row.left_early IS DISTINCT FROM (last_at<shift_row.ends_at-make_interval(secs=>(shift_row.attendance_policy->>'earlyGraceSeconds')::integer)) THEN RAISE EXCEPTION 'Attendance differs from its actual clock and break evidence; process the declared source sequence without guessed paid time.'; END IF;
 END IF;
 RETURN NULL;
END $function$;

CREATE FUNCTION public.hrm_shift_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
 VALUES(NEW.org_id,TG_TABLE_NAME,NEW.id,lower(TG_OP),CASE WHEN public.openbooks_clone_authority() THEN NULL
  ELSE coalesce(to_jsonb(NEW)->>'released_by',to_jsonb(NEW)->>'updated_by',to_jsonb(NEW)->>'created_by')::uuid END,
  jsonb_build_object('before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,'after',to_jsonb(NEW),
   'reason',CASE WHEN public.openbooks_clone_authority() THEN 'Preserve roster evidence during controlled sandbox cloning.' ELSE coalesce(to_jsonb(NEW)->>'release_reason',to_jsonb(NEW)->>'reason') END));
 RETURN NEW;
END $function$;
DO $block$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['hrm_shift_templates','hrm_shift_assignments','hrm_shift_publications','hrm_shifts','hrm_shift_requests','hrm_attendance_devices','hrm_attendance_identities','hrm_attendance_batches','hrm_attendance_events','hrm_attendance_watermarks','hrm_attendance_observations','hrm_attendance_event_claims','hrm_attendance_observation_events'] LOOP
  EXECUTE format('CREATE TRIGGER hrm_shift_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hrm_shift_guard()',tbl);
  EXECUTE format('CREATE TRIGGER hrm_shift_audit AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hrm_shift_audit()',tbl);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true))',tbl);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['hrm_shift_publications','hrm_attendance_batches','hrm_attendance_events','hrm_attendance_observations','hrm_shift_requests','hrm_shifts'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER hrm_shift_evidence_guard AFTER INSERT OR UPDATE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.hrm_shift_evidence_guard()',tbl);
 END LOOP;
END $block$;
CREATE FUNCTION public.hrm_shift_assert_attendance_current(tenant uuid, shift_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE shift_row public.hrm_shifts; observation_row public.hrm_attendance_observations; expected_ids uuid[]; linked_ids uuid[];
 capture_from timestamptz; capture_to timestamptz; mapped integer; pending integer;
BEGIN
 SELECT * INTO shift_row FROM public.hrm_shifts WHERE org_id=tenant AND id=shift_id FOR SHARE;
 PERFORM id FROM public.worker_employments WHERE org_id=tenant AND id=shift_row.employment_id FOR UPDATE;
 PERFORM d.id FROM public.hrm_attendance_devices d WHERE d.org_id=tenant AND EXISTS(SELECT 1 FROM public.hrm_attendance_identities i WHERE i.org_id=d.org_id AND i.device_id=d.id AND i.employment_id=shift_row.employment_id) ORDER BY d.id FOR SHARE;
 SELECT * INTO observation_row FROM public.hrm_attendance_observations o WHERE o.org_id=tenant AND o.shift_id=shift_id
  AND NOT EXISTS(SELECT 1 FROM public.hrm_attendance_observations n WHERE n.org_id=o.org_id AND n.supersedes_id=o.id) FOR SHARE;
 IF observation_row.status NOT IN ('absent','present') OR observation_row.id IS NULL THEN RAISE EXCEPTION 'Attendance has no current completed observation; synchronize mapped sources and process the shift before closing it.'; END IF;
 capture_from:=shift_row.starts_at-make_interval(secs=>(shift_row.attendance_policy->>'captureBeforeSeconds')::integer);
 capture_to:=shift_row.ends_at+make_interval(secs=>(shift_row.attendance_policy->>'captureAfterSeconds')::integer);
 IF EXISTS(SELECT 1 FROM public.hrm_attendance_identities i JOIN public.hrm_attendance_devices d ON d.org_id=i.org_id AND d.id=i.device_id
  WHERE i.org_id=tenant AND i.employment_id=shift_row.employment_id
   AND daterange(i.effective_from,i.effective_to,'[)') && daterange((capture_from AT TIME ZONE d.time_zone)::date,(capture_to AT TIME ZONE d.time_zone)::date,'[]')
   AND NOT daterange(i.effective_from,i.effective_to,'[)') @> daterange((capture_from AT TIME ZONE d.time_zone)::date,(capture_to AT TIME ZONE d.time_zone)::date,'[]')) THEN
  RAISE EXCEPTION 'A device identity changes inside the capture window; reconcile its dated source mapping and reprocess attendance before closing.';
 END IF;
 SELECT count(*),count(*) FILTER(WHERE w.complete_through IS NULL OR w.complete_through<capture_to) INTO mapped,pending
 FROM public.hrm_attendance_identities i JOIN public.hrm_attendance_devices d ON d.org_id=i.org_id AND d.id=i.device_id
 LEFT JOIN public.hrm_attendance_watermarks w ON w.org_id=i.org_id AND w.device_id=i.device_id
 WHERE i.org_id=tenant AND i.employment_id=shift_row.employment_id
  AND daterange(i.effective_from,i.effective_to,'[)') @> daterange((capture_from AT TIME ZONE d.time_zone)::date,(capture_to AT TIME ZONE d.time_zone)::date,'[]');
 IF mapped=0 OR pending>0 THEN RAISE EXCEPTION 'Attendance sources are not currently complete; synchronize every dated device and reprocess the shift before closing it.'; END IF;
 SELECT coalesce(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[]) INTO expected_ids FROM public.hrm_attendance_events e
 WHERE e.org_id=tenant AND e.employment_id=shift_row.employment_id AND e.occurred_at BETWEEN capture_from AND capture_to AND e.kind<>'void'
 AND NOT EXISTS(SELECT 1 FROM public.hrm_attendance_events n WHERE n.org_id=e.org_id AND n.supersedes_id=e.id);
 SELECT coalesce(array_agg(c.event_id ORDER BY c.event_id),ARRAY[]::uuid[]) INTO linked_ids FROM public.hrm_attendance_observation_events oe
 JOIN public.hrm_attendance_event_claims c ON c.org_id=oe.org_id AND c.id=oe.event_claim_id WHERE oe.org_id=tenant AND oe.observation_id=observation_row.id AND c.released_at IS NULL;
 IF expected_ids IS DISTINCT FROM linked_ids THEN RAISE EXCEPTION 'Attendance source evidence changed after processing; reprocess the shift before closing it, preserving the earlier observation.'; END IF;
END $function$;
