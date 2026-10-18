-- Service dispatch: service requests, assessment and service visits, service
-- jobs with priced scope, recurring service agreements, service quotes on
-- native estimates, and the dispatch board type.
--
-- A service request records work a customer asks for, entered by staff or
-- submitted through the customer portal. Assessment visits belong to the
-- request; service visits belong to a service job. A job carries the service
-- location (a party address), the site contact, the priced scope lines,
-- priority, required qualifications, the duration estimate and the SLA due
-- time. Visits carry the arrival window and the live field status
-- (scheduled, dispatched, en route, on site, completed or unable to
-- complete), recorded with an append-only status history.
--
-- Quotes are native estimate documents. A service quote adds which estimate
-- lines are optional add-ons, the required deposit, and the customer's
-- acceptance through the native signature request ledger.
--
-- Visits are booked as schedule entries on dispatch boards, the new board
-- type with the dispatch capability, so a technician is never double-booked
-- across boards. A booking names its visit; replacements keep it.
--
-- Recurring service agreements generate visits from effective-dated
-- versions. Each occurrence is generated once per agreement and date; a
-- skipped or cancelled occurrence is a decision regeneration keeps, and an
-- occurrence superseded by a later version is generated again under it.
--
-- Completion records work notes, parts issued from inventory, labor time
-- entries linked to the visit, and the customer's signature. Jobs are
-- invoiced per visit or per job through native customer invoices; billing
-- links release only when the invoice is voided. Deposits are native
-- customer payments held on account and applied to the job's invoices.
--
-- Backfill: new tables start empty; existing boards, bookings and time
-- entries are unchanged. Built-in administrator and controller roles gain
-- the service grants, and each organization gains the built-in Service
-- Dispatcher and Field Technician roles.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- Party addresses and contacts gain the composite identity tenant foreign
-- keys use.
CREATE UNIQUE INDEX addresses_org_id_id_unique ON public.addresses(org_id, id);
CREATE UNIQUE INDEX contacts_org_id_id_unique ON public.contacts(org_id, id);

-- Service dispatch writes require Human Resources, Scheduling and Service
-- dispatch to be switched on explicitly (all three default off).
CREATE FUNCTION public.service_dispatch_enabled(tenant uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $function$
 SELECT coalesce((SELECT o.settings->'features'->'hrm' = 'true'::jsonb
   AND o.settings->'features'->'hrmShiftPlanning' = 'true'::jsonb
   AND o.settings->'features'->'serviceDispatch' = 'true'::jsonb
  FROM public.orgs o WHERE o.id = tenant), false);
$function$;

-- Dispatch boards: a people board type with the dispatch capability and the
-- dispatch view.
INSERT INTO public.openbooks_schedule_board_types (key, row_kind, capabilities, added_in) VALUES
 ('dispatch', 'people', ARRAY['bookings','dispatch']::text[], '0751')
ON CONFLICT (key) DO NOTHING; -- expected on replay; the registry seed is idempotent

CREATE OR REPLACE FUNCTION public.schedule_board_views_valid(row_kind text, views text[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $function$
 SELECT coalesce(array_length(views,1),0) BETWEEN 1 AND 6 AND array_ndims(views) = 1
  AND (SELECT count(DISTINCT v) FROM unnest(views) v) = array_length(views,1)
  AND views <@ CASE row_kind WHEN 'people' THEN ARRAY['grid','targets','timeline','calendar','dispatch']::text[]
   WHEN 'resources' THEN ARRAY['grid','targets','timeline','calendar']::text[]
   WHEN 'tasks' THEN ARRAY['gantt','progress']::text[] ELSE ARRAY[]::text[] END;
$function$;

CREATE OR REPLACE FUNCTION public.schedule_boards_type_guard() RETURNS trigger
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
 IF ('dispatch' = ANY (NEW.views)) <> ('dispatch' = ANY (board_type.capabilities)) THEN
  RAISE EXCEPTION 'The dispatch view belongs to dispatch boards, and every dispatch board shows it.' USING ERRCODE = '23514';
 END IF;
 IF 'dispatch' = ANY (board_type.capabilities) AND NEW.publish_policy <> 'live' THEN
  RAISE EXCEPTION 'Dispatch boards publish each assignment as it is made so technicians see it at once; choose live publishing.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $function$;

-- Effective-dated dispatch policy: customer notices, the default arrival
-- window, response targets by priority and the agreement horizon. Versions
-- are appended, never rewritten.
CREATE TABLE public.service_dispatch_policies (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 effective_from date NOT NULL CHECK (effective_from BETWEEN DATE '2000-01-01' AND DATE '9999-12-31'),
 notify_arrival_window boolean NOT NULL,
 notify_en_route boolean NOT NULL,
 arrival_window_minutes smallint NOT NULL CHECK (arrival_window_minutes BETWEEN 15 AND 720),
 default_visit_minutes smallint NOT NULL CHECK (default_visit_minutes BETWEEN 5 AND 1440),
 urgent_response_hours smallint CHECK (urgent_response_hours BETWEEN 1 AND 8760),
 high_response_hours smallint CHECK (high_response_hours BETWEEN 1 AND 8760),
 normal_response_hours smallint CHECK (normal_response_hours BETWEEN 1 AND 8760),
 low_response_hours smallint CHECK (low_response_hours BETWEEN 1 AND 8760),
 agreement_horizon_days smallint NOT NULL CHECK (agreement_horizon_days BETWEEN 7 AND 366),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, effective_from),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
COMMENT ON TABLE public.service_dispatch_policies IS
 'Effective-dated service dispatch policy: customer arrival-window and on-my-way notices (opt-in), the default arrival window and visit length, response targets by priority and how far ahead agreements generate visits. A change appends a version from its effective date.';

CREATE TABLE public.service_requests (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 request_number text NOT NULL CHECK (length(btrim(request_number)) BETWEEN 1 AND 40),
 customer_party_id uuid NOT NULL,
 service_address_id uuid,
 contact_id uuid,
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
 description text CHECK (description IS NULL OR length(description) <= 8000),
 priority text NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
 preferred_on date,
 preferred_time text NOT NULL DEFAULT 'any' CHECK (preferred_time IN ('any','morning','afternoon','evening')),
 source text NOT NULL CHECK (source IN ('staff','portal')),
 portal_link_id uuid,
 status text NOT NULL CHECK (status IN ('new','assessment_scheduled','assessed','quoted','converted','declined','cancelled')),
 close_reason text CHECK (close_reason IS NULL OR length(btrim(close_reason)) BETWEEN 1 AND 2000),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 UNIQUE (org_id, id),
 UNIQUE (org_id, request_number),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, customer_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, service_address_id) REFERENCES public.addresses(org_id, id),
 FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_requests_source CHECK ((source = 'staff') = (created_by IS NOT NULL AND portal_link_id IS NULL)),
 CONSTRAINT service_requests_closed CHECK ((status IN ('declined','cancelled')) = (close_reason IS NOT NULL))
);
CREATE INDEX service_requests_status ON public.service_requests(org_id, status, created_at);
CREATE INDEX service_requests_customer ON public.service_requests(org_id, customer_party_id, created_at);
COMMENT ON TABLE public.service_requests IS
 'Work a customer asks for, entered by staff or submitted through the customer portal. It moves through assessment and quoting to a service job (the job names the request), or is declined or cancelled with a reason.';

CREATE TABLE public.service_agreements (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 agreement_number text NOT NULL CHECK (length(btrim(agreement_number)) BETWEEN 1 AND 40),
 customer_party_id uuid NOT NULL,
 service_address_id uuid,
 contact_id uuid,
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
 starts_on date NOT NULL,
 ends_on date,
 status text NOT NULL CHECK (status IN ('active','ended','cancelled')),
 generated_through date,
 close_reason text CHECK (close_reason IS NULL OR length(btrim(close_reason)) BETWEEN 1 AND 2000),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, agreement_number),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, customer_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, service_address_id) REFERENCES public.addresses(org_id, id),
 FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_agreements_window CHECK (ends_on IS NULL OR ends_on >= starts_on),
 CONSTRAINT service_agreements_closed CHECK ((status = 'active') = (close_reason IS NULL))
);
CREATE INDEX service_agreements_active ON public.service_agreements(org_id, status, generated_through);
COMMENT ON TABLE public.service_agreements IS
 'Recurring service agreements. Each agreement owns one service job billed per visit (the job names the agreement) and generates its visits from effective-dated versions through the policy horizon.';

CREATE TABLE public.service_agreement_versions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 agreement_id uuid NOT NULL,
 effective_from date NOT NULL,
 recurrence jsonb NOT NULL,
 window_starts time NOT NULL,
 window_ends time NOT NULL,
 estimated_minutes smallint NOT NULL CHECK (estimated_minutes BETWEEN 5 AND 1440),
 priority text NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
 required_qualification_type_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
  CHECK (coalesce(array_ndims(required_qualification_type_ids), 1) = 1 AND coalesce(array_length(required_qualification_type_ids, 1), 0) <= 100),
 instructions text CHECK (instructions IS NULL OR length(instructions) <= 4000),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, agreement_id, effective_from),
 FOREIGN KEY (org_id, agreement_id) REFERENCES public.service_agreements(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_agreement_versions_window CHECK (window_ends > window_starts),
 CONSTRAINT service_agreement_versions_recurrence CHECK (jsonb_typeof(recurrence) = 'object'
  AND recurrence->>'repeat' IN ('daily','weekly','monthly','yearly')
  AND jsonb_typeof(recurrence->'interval') = 'number' AND (recurrence->>'interval') ~ '^[0-9]{1,2}$' AND (recurrence->>'interval')::integer BETWEEN 1 AND 52)
);
COMMENT ON TABLE public.service_agreement_versions IS
 'Effective-dated terms of a service agreement: recurrence, arrival window, visit length, priority, required qualifications and per-visit lines. Versions are appended; visits keep the version that generated them.';

CREATE TABLE public.service_agreement_lines (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 version_id uuid NOT NULL,
 line_number smallint NOT NULL CHECK (line_number BETWEEN 1 AND 500),
 item_id uuid NOT NULL,
 description text CHECK (description IS NULL OR length(description) <= 2000),
 quantity numeric(28,8) NOT NULL CHECK (quantity > 0),
 unit_price numeric(28,8) NOT NULL CHECK (unit_price >= 0),
 tax_code_id uuid,
 UNIQUE (org_id, id),
 UNIQUE (org_id, version_id, line_number),
 FOREIGN KEY (org_id, version_id) REFERENCES public.service_agreement_versions(org_id, id),
 FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id),
 FOREIGN KEY (org_id, tax_code_id) REFERENCES public.tax_codes(org_id, id)
);
COMMENT ON TABLE public.service_agreement_lines IS
 'Per-visit priced lines of an agreement version; each completed agreement visit invoices them once.';

CREATE TABLE public.service_jobs (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 job_number text NOT NULL CHECK (length(btrim(job_number)) BETWEEN 1 AND 40),
 customer_party_id uuid NOT NULL,
 service_address_id uuid,
 contact_id uuid,
 request_id uuid,
 quote_document_id uuid,
 agreement_id uuid,
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
 description text CHECK (description IS NULL OR length(description) <= 8000),
 priority text NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
 required_qualification_type_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
  CHECK (coalesce(array_ndims(required_qualification_type_ids), 1) = 1 AND coalesce(array_length(required_qualification_type_ids, 1), 0) <= 100),
 estimated_minutes smallint NOT NULL CHECK (estimated_minutes BETWEEN 5 AND 1440),
 sla_due_at timestamptz,
 billing_mode text NOT NULL CHECK (billing_mode IN ('per_job','per_visit','not_billable')),
 labor_item_id uuid,
 labor_unit_price numeric(28,8) CHECK (labor_unit_price IS NULL OR labor_unit_price >= 0),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 deposit_required numeric(19,4) NOT NULL DEFAULT 0 CHECK (deposit_required >= 0),
 status text NOT NULL CHECK (status IN ('open','completed','cancelled')),
 completed_at timestamptz,
 completed_by uuid,
 close_reason text CHECK (close_reason IS NULL OR length(btrim(close_reason)) BETWEEN 1 AND 2000),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, job_number),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, customer_party_id) REFERENCES public.parties(org_id, id),
 FOREIGN KEY (org_id, service_address_id) REFERENCES public.addresses(org_id, id),
 FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id),
 FOREIGN KEY (org_id, request_id) REFERENCES public.service_requests(org_id, id),
 FOREIGN KEY (org_id, quote_document_id) REFERENCES public.documents(org_id, id),
 FOREIGN KEY (org_id, agreement_id) REFERENCES public.service_agreements(org_id, id),
 FOREIGN KEY (org_id, labor_item_id) REFERENCES public.items(org_id, id),
 FOREIGN KEY (org_id, completed_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_jobs_labor CHECK ((labor_item_id IS NULL) = (labor_unit_price IS NULL)),
 CONSTRAINT service_jobs_completion CHECK ((status = 'completed') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)
  AND ((status = 'cancelled') = (close_reason IS NOT NULL))),
 CONSTRAINT service_jobs_agreement CHECK (agreement_id IS NULL OR billing_mode IN ('per_visit','not_billable'))
);
CREATE UNIQUE INDEX service_jobs_one_per_agreement ON public.service_jobs(org_id, agreement_id) WHERE agreement_id IS NOT NULL;
CREATE UNIQUE INDEX service_jobs_one_per_request ON public.service_jobs(org_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX service_jobs_status ON public.service_jobs(org_id, status, created_at);
CREATE INDEX service_jobs_customer ON public.service_jobs(org_id, customer_party_id, created_at);
COMMENT ON TABLE public.service_jobs IS
 'Service jobs: the service location, site contact, priced scope, priority, required qualifications, duration estimate and response target for work done over one or more visits, invoiced per visit or per job through native invoices.';

CREATE TABLE public.service_job_lines (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 job_id uuid NOT NULL,
 line_number smallint NOT NULL CHECK (line_number BETWEEN 1 AND 500),
 item_id uuid NOT NULL,
 description text CHECK (description IS NULL OR length(description) <= 2000),
 quantity numeric(28,8) NOT NULL CHECK (quantity > 0),
 unit_price numeric(28,8) NOT NULL CHECK (unit_price >= 0),
 tax_code_id uuid,
 source_quote_line_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, job_id, line_number),
 FOREIGN KEY (org_id, job_id) REFERENCES public.service_jobs(org_id, id),
 FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id),
 FOREIGN KEY (org_id, tax_code_id) REFERENCES public.tax_codes(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
COMMENT ON TABLE public.service_job_lines IS
 'The priced scope of a service job, copied from the accepted quote lines or entered on the job. Per-job billing invoices them once; per-visit billing invoices them for each completed visit.';

CREATE TABLE public.service_quotes (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 quote_document_id uuid NOT NULL,
 request_id uuid,
 job_id uuid,
 deposit_basis text NOT NULL CHECK (deposit_basis IN ('none','percent','amount')),
 deposit_value numeric(19,4) NOT NULL DEFAULT 0 CHECK (deposit_value >= 0),
 status text NOT NULL CHECK (status IN ('draft','sent','accepted','declined')),
 signature_request_id uuid,
 sent_at timestamptz,
 decided_at timestamptz,
 decided_name text CHECK (decided_name IS NULL OR length(btrim(decided_name)) BETWEEN 1 AND 120),
 accepted_total numeric(19,4),
 deposit_due numeric(19,4),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 UNIQUE (org_id, id),
 UNIQUE (org_id, quote_document_id),
 FOREIGN KEY (org_id, quote_document_id) REFERENCES public.documents(org_id, id),
 FOREIGN KEY (org_id, request_id) REFERENCES public.service_requests(org_id, id),
 FOREIGN KEY (org_id, job_id) REFERENCES public.service_jobs(org_id, id),
 FOREIGN KEY (org_id, signature_request_id) REFERENCES public.signature_requests(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_quotes_deposit CHECK ((deposit_basis = 'none') = (deposit_value = 0)
  AND (deposit_basis <> 'percent' OR deposit_value <= 100)),
 CONSTRAINT service_quotes_decision CHECK (
  (status IN ('accepted','declined')) = (decided_at IS NOT NULL AND decided_name IS NOT NULL)
  AND ((status = 'accepted') = (accepted_total IS NOT NULL AND deposit_due IS NOT NULL))
  AND (status = 'draft' OR (sent_at IS NOT NULL AND signature_request_id IS NOT NULL)))
);
COMMENT ON TABLE public.service_quotes IS
 'Service terms on a native estimate: which lines are optional add-ons, the required deposit, and the customer''s acceptance or decline through the native signature request ledger.';

CREATE TABLE public.service_quote_lines (
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 quote_document_id uuid NOT NULL,
 document_line_id uuid NOT NULL,
 optional boolean NOT NULL,
 selected boolean,
 PRIMARY KEY (org_id, document_line_id),
 FOREIGN KEY (org_id, quote_document_id) REFERENCES public.service_quotes(org_id, quote_document_id),
 CONSTRAINT service_quote_lines_selection CHECK (optional OR selected IS NULL OR selected)
);
COMMENT ON TABLE public.service_quote_lines IS
 'Optional add-on markings on estimate lines and the customer''s selection recorded at acceptance. Estimate lines stay editable through the native estimate editor until the quote is sent, so the marking names the line without a foreign key and is reconciled when the quote is sent.';
COMMENT ON COLUMN public.service_job_lines.source_quote_line_id IS
 'The estimate line this scope line was accepted from; kept as evidence without a foreign key so the estimate''s own lifecycle is unchanged.';

CREATE TABLE public.service_visits (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('assessment','service')),
 request_id uuid,
 job_id uuid,
 sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 9999),
 agreement_id uuid,
 agreement_version_id uuid,
 occurs_on date,
 status text NOT NULL CHECK (status IN ('unscheduled','scheduled','dispatched','en_route','on_site','completed','unable_to_complete','cancelled')),
 cancel_kind text CHECK (cancel_kind IN ('cancelled','skipped','superseded')),
 priority text NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
 required_qualification_type_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]
  CHECK (coalesce(array_ndims(required_qualification_type_ids), 1) = 1 AND coalesce(array_length(required_qualification_type_ids, 1), 0) <= 100),
 estimated_minutes smallint NOT NULL CHECK (estimated_minutes BETWEEN 5 AND 1440),
 preferred_on date,
 window_starts_at timestamptz,
 window_ends_at timestamptz,
 sla_due_at timestamptz,
 instructions text CHECK (instructions IS NULL OR length(instructions) <= 4000),
 work_notes text CHECK (work_notes IS NULL OR length(work_notes) <= 8000),
 outcome_reason text CHECK (outcome_reason IS NULL OR length(btrim(outcome_reason)) BETWEEN 1 AND 2000),
 dispatched_at timestamptz,
 en_route_at timestamptz,
 arrived_at timestamptz,
 completed_at timestamptz,
 completed_by uuid,
 review_status text CHECK (review_status IN ('not_required','pending','approved','rejected')),
 review_flow_run_id uuid,
 review_decided_by uuid,
 review_decided_at timestamptz,
 review_reason text CHECK (review_reason IS NULL OR length(btrim(review_reason)) BETWEEN 1 AND 2000),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 FOREIGN KEY (org_id, request_id) REFERENCES public.service_requests(org_id, id),
 FOREIGN KEY (org_id, job_id) REFERENCES public.service_jobs(org_id, id),
 FOREIGN KEY (org_id, agreement_id) REFERENCES public.service_agreements(org_id, id),
 FOREIGN KEY (org_id, agreement_version_id) REFERENCES public.service_agreement_versions(org_id, id),
 FOREIGN KEY (org_id, completed_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, review_decided_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_visits_parent CHECK ((kind = 'assessment' AND request_id IS NOT NULL AND job_id IS NULL)
  OR (kind = 'service' AND job_id IS NOT NULL AND request_id IS NULL)),
 CONSTRAINT service_visits_occurrence CHECK ((agreement_id IS NULL) = (agreement_version_id IS NULL)
  AND (agreement_id IS NULL) = (occurs_on IS NULL) AND (agreement_id IS NULL OR kind = 'service')),
 CONSTRAINT service_visits_window CHECK ((window_starts_at IS NULL) = (window_ends_at IS NULL)
  AND (window_ends_at IS NULL OR window_ends_at > window_starts_at)),
 CONSTRAINT service_visits_cancel CHECK ((status = 'cancelled') = (cancel_kind IS NOT NULL)
  AND (cancel_kind IS NULL OR outcome_reason IS NOT NULL)
  AND (cancel_kind IS DISTINCT FROM 'skipped' OR agreement_id IS NOT NULL)
  AND (cancel_kind IS DISTINCT FROM 'superseded' OR agreement_id IS NOT NULL)),
 CONSTRAINT service_visits_completion CHECK (
  (status = 'completed') = (completed_at IS NOT NULL AND completed_by IS NOT NULL AND work_notes IS NOT NULL AND length(btrim(work_notes)) > 0)
  AND (status <> 'unable_to_complete' OR outcome_reason IS NOT NULL)
  AND ((review_status IS NULL) = (status <> 'completed' AND review_decided_at IS NULL))
  AND ((review_status IN ('approved','rejected') AND review_decided_by IS NOT NULL) = (review_decided_at IS NOT NULL AND review_reason IS NOT NULL)))
);
CREATE UNIQUE INDEX service_visits_occurrence_key ON public.service_visits(org_id, agreement_id, occurs_on)
 WHERE agreement_id IS NOT NULL AND cancel_kind IS DISTINCT FROM 'superseded';
CREATE UNIQUE INDEX service_visits_job_sequence ON public.service_visits(org_id, job_id, sequence) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX service_visits_request_sequence ON public.service_visits(org_id, request_id, sequence) WHERE request_id IS NOT NULL;
CREATE INDEX service_visits_queue ON public.service_visits(org_id, status, priority, preferred_on) WHERE status = 'unscheduled';
CREATE INDEX service_visits_job ON public.service_visits(org_id, job_id);
COMMENT ON TABLE public.service_visits IS
 'Assessment visits of a service request and service visits of a job: arrival window, duration, response target, required qualifications and the live field status. Booked on dispatch boards as schedule entries that name the visit.';

-- The booking ledger names the visit a dispatch booking serves.
ALTER TABLE public.schedule_entries
 ADD COLUMN service_visit_id uuid,
 ADD CONSTRAINT schedule_entries_service_visit_fkey FOREIGN KEY (org_id, service_visit_id) REFERENCES public.service_visits(org_id, id);
CREATE UNIQUE INDEX schedule_entries_service_visit_worker ON public.schedule_entries(org_id, service_visit_id, worker_party_id)
 WHERE service_visit_id IS NOT NULL AND status = 'published';
CREATE INDEX schedule_entries_service_visit ON public.schedule_entries(org_id, service_visit_id) WHERE service_visit_id IS NOT NULL;
COMMENT ON COLUMN public.schedule_entries.service_visit_id IS
 'The service visit a dispatch booking serves. Only boards whose type declares the dispatch capability carry visit bookings; a replacement booking keeps its predecessor''s visit.';

CREATE FUNCTION public.schedule_entries_service_visit_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE prior_visit uuid;
BEGIN
 IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND NEW.service_visit_id IS DISTINCT FROM OLD.service_visit_id THEN
  RAISE EXCEPTION 'A booking keeps the service visit it serves; book the visit again instead.' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.supersedes_id IS NOT NULL THEN
   SELECT service_visit_id INTO prior_visit FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.supersedes_id;
   IF prior_visit IS DISTINCT FROM NEW.service_visit_id THEN
    RAISE EXCEPTION 'A replacement booking serves the same service visit as the booking it replaces.' USING ERRCODE = '23514';
   END IF;
  END IF;
  IF NEW.service_visit_id IS NOT NULL THEN
   IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'dispatch') THEN
    RAISE EXCEPTION 'Service visits are booked on dispatch boards; open a dispatch board to assign the visit.' USING ERRCODE = '23514';
   END IF;
   IF NEW.worker_party_id IS NULL THEN
    RAISE EXCEPTION 'A service visit is booked on a technician.' USING ERRCODE = '23514';
   END IF;
   IF NOT public.service_dispatch_enabled(NEW.org_id) THEN
    RAISE EXCEPTION 'Service dispatch is switched off; enable it on Company Settings → Features before booking visits.' USING ERRCODE = '23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_entries_service_visit_guard BEFORE INSERT OR UPDATE ON public.schedule_entries
 FOR EACH ROW EXECUTE FUNCTION public.schedule_entries_service_visit_guard();

CREATE TABLE public.service_visit_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 visit_id uuid NOT NULL,
 from_status text CHECK (from_status IN ('unscheduled','scheduled','dispatched','en_route','on_site','completed','unable_to_complete','cancelled')),
 to_status text NOT NULL CHECK (to_status IN ('unscheduled','scheduled','dispatched','en_route','on_site','completed','unable_to_complete','cancelled')),
 visit_revision integer NOT NULL CHECK (visit_revision > 0),
 occurred_at timestamptz NOT NULL DEFAULT now(),
 actor_id uuid,
 worker_party_id uuid,
 reason text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
 UNIQUE (org_id, id),
 UNIQUE (org_id, visit_id, visit_revision),
 FOREIGN KEY (org_id, visit_id) REFERENCES public.service_visits(org_id, id),
 FOREIGN KEY (org_id, actor_id) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, worker_party_id) REFERENCES public.parties(org_id, id)
);
CREATE INDEX service_visit_events_visit ON public.service_visit_events(org_id, visit_id, occurred_at);
COMMENT ON TABLE public.service_visit_events IS
 'Append-only history of each visit''s field status with the actor, the technician and the reason.';

CREATE TABLE public.service_visit_parts (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 visit_id uuid NOT NULL,
 item_id uuid NOT NULL,
 stock_location_id uuid NOT NULL,
 quantity numeric(19,4) NOT NULL CHECK (quantity > 0),
 unit_price numeric(28,8) NOT NULL CHECK (unit_price >= 0),
 billable boolean NOT NULL,
 memo text CHECK (memo IS NULL OR length(memo) <= 500),
 lot_id uuid,
 serial_id uuid,
 inventory_movement_id uuid,
 issued_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, visit_id) REFERENCES public.service_visits(org_id, id),
 FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id),
 FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations(org_id, id),
 FOREIGN KEY (org_id, lot_id) REFERENCES public.lots(org_id, id),
 FOREIGN KEY (org_id, serial_id) REFERENCES public.serials(org_id, id),
 FOREIGN KEY (org_id, inventory_movement_id) REFERENCES public.inventory_movements(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_visit_parts_issue CHECK ((inventory_movement_id IS NULL) = (issued_at IS NULL))
);
CREATE INDEX service_visit_parts_visit ON public.service_visit_parts(org_id, visit_id);
COMMENT ON TABLE public.service_visit_parts IS
 'Parts used on a visit: issued from stock through a native inventory issue when the visit completes, and billed at the recorded price when billable.';

CREATE TABLE public.service_visit_signature_requests (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 visit_id uuid NOT NULL,
 recipient text CHECK (recipient IS NULL OR length(btrim(recipient)) BETWEEN 3 AND 320),
 token_digest text NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,
 email_log_id uuid REFERENCES public.email_log(id),
 responded_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (token_digest),
 FOREIGN KEY (org_id, visit_id) REFERENCES public.service_visits(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_visit_signature_requests_closed CHECK (responded_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX service_visit_signature_requests_open ON public.service_visit_signature_requests(org_id, visit_id)
 WHERE responded_at IS NULL AND revoked_at IS NULL;
COMMENT ON TABLE public.service_visit_signature_requests IS
 'Customer signing links for a visit: only the token digest is stored. Signing delivery plumbing, so the table stays out of the governed-query catalog.';

CREATE TABLE public.service_visit_signatures (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 visit_id uuid NOT NULL,
 request_id uuid NOT NULL,
 signer_name text NOT NULL CHECK (length(btrim(signer_name)) BETWEEN 1 AND 120),
 comment text CHECK (comment IS NULL OR length(comment) <= 2000),
 signature_file_id uuid NOT NULL,
 signed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (org_id, id),
 UNIQUE (org_id, visit_id),
 FOREIGN KEY (org_id, visit_id) REFERENCES public.service_visits(org_id, id),
 FOREIGN KEY (org_id, request_id) REFERENCES public.service_visit_signature_requests(org_id, id),
 FOREIGN KEY (org_id, signature_file_id) REFERENCES public.files(org_id, id)
);
COMMENT ON TABLE public.service_visit_signatures IS
 'The customer''s signature on a visit, captured once through its signing link with the signed image stored in the file cabinet.';

CREATE TABLE public.service_billings (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 job_id uuid NOT NULL,
 visit_id uuid,
 invoice_document_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 released_at timestamptz,
 released_by uuid,
 release_reason text CHECK (release_reason IS NULL OR length(btrim(release_reason)) BETWEEN 1 AND 2000),
 UNIQUE (org_id, id),
 FOREIGN KEY (org_id, job_id) REFERENCES public.service_jobs(org_id, id),
 FOREIGN KEY (org_id, visit_id) REFERENCES public.service_visits(org_id, id),
 FOREIGN KEY (org_id, invoice_document_id) REFERENCES public.documents(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id),
 FOREIGN KEY (org_id, released_by) REFERENCES public.users(org_id, id),
 CONSTRAINT service_billings_release CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL))
);
CREATE UNIQUE INDEX service_billings_job_active ON public.service_billings(org_id, job_id) WHERE visit_id IS NULL AND released_at IS NULL;
CREATE UNIQUE INDEX service_billings_visit_active ON public.service_billings(org_id, visit_id) WHERE visit_id IS NOT NULL AND released_at IS NULL;
CREATE INDEX service_billings_invoice ON public.service_billings(org_id, invoice_document_id);
COMMENT ON TABLE public.service_billings IS
 'The native invoice that billed a job or one of its visits. A billing is released only when its invoice is voided, so work is never invoiced twice.';

CREATE TABLE public.service_job_deposits (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 job_id uuid NOT NULL,
 payment_document_id uuid NOT NULL,
 amount numeric(19,4) NOT NULL CHECK (amount > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 UNIQUE (org_id, id),
 UNIQUE (org_id, payment_document_id),
 FOREIGN KEY (org_id, job_id) REFERENCES public.service_jobs(org_id, id),
 FOREIGN KEY (org_id, payment_document_id) REFERENCES public.documents(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
COMMENT ON TABLE public.service_job_deposits IS
 'Deposits received for a job: native customer payments held on account and applied to the job''s invoices through native credit settlement.';

CREATE TABLE public.service_customer_notices (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 visit_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('arrival_window','en_route')),
 occurrence_key text NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 200),
 recipient text,
 status text NOT NULL CHECK (status IN ('queued','sent','suppressed','failed')),
 detail text CHECK (detail IS NULL OR length(detail) <= 2000),
 email_log_id uuid REFERENCES public.email_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 UNIQUE (org_id, id),
 UNIQUE (org_id, visit_id, kind, occurrence_key),
 FOREIGN KEY (org_id, visit_id) REFERENCES public.service_visits(org_id, id),
 FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
COMMENT ON TABLE public.service_customer_notices IS
 'Customer arrival-window and on-my-way notices, one per visit, kind and booking: claimed as queued before sending, then recorded as sent or failed. Delivery plumbing, so the table stays out of the governed-query catalog.';

-- Labor time on native time entries: a service visit is a cost object like
-- a project or a manufacturing work order, and an entry names at most one.
ALTER TABLE public.time_entries
 ADD COLUMN service_visit_id uuid,
 ADD CONSTRAINT time_entries_service_visit_fkey FOREIGN KEY (org_id, service_visit_id) REFERENCES public.service_visits(org_id, id),
 DROP CONSTRAINT time_entries_one_cost_object_check,
 ADD CONSTRAINT time_entries_one_cost_object_check CHECK (num_nonnulls(project_id, work_order_id, service_visit_id) <= 1);
CREATE INDEX time_entries_service_visit ON public.time_entries(org_id, service_visit_id) WHERE service_visit_id IS NOT NULL;
COMMENT ON COLUMN public.time_entries.service_visit_id IS
 'The service visit this labor was worked on, recorded when the technician completes the visit. Exclusive with a project or a work order.';

-- Lifecycle guards. Service records are never deleted outside tenant
-- retirement and sandbox wipes; revisioned records advance one revision per
-- change and keep their identity and parent.
CREATE FUNCTION public.service_record_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE immutable text[]; visit_status text; job_open boolean; o jsonb; n jsonb; tenant uuid; job uuid;
BEGIN
 -- Table-specific columns are read through jsonb so one guard serves every service table.
 o := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
 n := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
 tenant := coalesce(n->>'org_id', o->>'org_id')::uuid;
 IF TG_OP = 'DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, o) OR public.openbooks_sandbox_wipe_allowed(tenant) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'service_visit_parts' AND o->>'inventory_movement_id' IS NULL THEN
   SELECT status INTO visit_status FROM public.service_visits WHERE org_id = tenant AND id = (o->>'visit_id')::uuid FOR SHARE;
   IF visit_status IN ('completed','unable_to_complete','cancelled') THEN
    RAISE EXCEPTION 'Parts on a finished visit are its history; record a correction on a new visit instead.' USING ERRCODE = '23514';
   END IF;
   RETURN OLD;
  END IF;
  -- Discarding a draft invoice releases the work it billed; discarding a
  -- draft estimate drops its unsent service terms.
  IF TG_TABLE_NAME = 'service_billings' AND o->>'released_at' IS NULL AND EXISTS (SELECT 1 FROM public.documents d
    WHERE d.org_id = tenant AND d.id = (o->>'invoice_document_id')::uuid AND d.status = 'draft') THEN
   RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'service_quotes' AND o->>'status' = 'draft' THEN
   RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'service_quote_lines' THEN
   IF o->>'selected' IS NOT NULL THEN
    RAISE EXCEPTION 'The customer''s add-on selection is final.' USING ERRCODE = '23514';
   END IF;
   RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'service_job_lines' THEN
   job := (o->>'job_id')::uuid;
   SELECT status = 'open' AND NOT EXISTS (SELECT 1 FROM public.service_billings b WHERE b.org_id = tenant AND b.job_id = job AND b.released_at IS NULL)
    INTO job_open FROM public.service_jobs WHERE org_id = tenant AND id = job FOR SHARE;
   IF NOT coalesce(job_open, false) THEN
    RAISE EXCEPTION 'Job lines change only while the job is open and not yet invoiced.' USING ERRCODE = '23514';
   END IF;
   RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Service history cannot be deleted; cancel or close the record instead.' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
  IF NOT public.service_dispatch_enabled(tenant) THEN
   RAISE EXCEPTION 'Service dispatch is switched off; enable it on Company Settings → Features. Existing service records are preserved.' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'service_job_lines' THEN
   job := (n->>'job_id')::uuid;
   SELECT status = 'open' AND NOT EXISTS (SELECT 1 FROM public.service_billings b WHERE b.org_id = tenant AND b.job_id = job AND b.released_at IS NULL)
    INTO job_open FROM public.service_jobs WHERE org_id = tenant AND id = job FOR SHARE;
   IF NOT coalesce(job_open, false) THEN
    RAISE EXCEPTION 'Job lines change only while the job is open and not yet invoiced.' USING ERRCODE = '23514';
   END IF;
  END IF;
  IF TG_TABLE_NAME = 'service_visit_parts' THEN
   SELECT status INTO visit_status FROM public.service_visits WHERE org_id = tenant AND id = (n->>'visit_id')::uuid FOR SHARE;
   IF visit_status IS NULL OR visit_status NOT IN ('scheduled','dispatched','en_route','on_site') THEN
    RAISE EXCEPTION 'Parts are recorded on a scheduled or active visit.' USING ERRCODE = '23514';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 -- UPDATE
 -- A governed party merge re-points the customer only; every other fact,
 -- including the revision, is preserved.
 IF TG_TABLE_NAME IN ('service_requests','service_jobs','service_agreements')
    AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on'
    AND coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
    AND n - 'customer_party_id' = o - 'customer_party_id' THEN
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME IN ('service_requests','service_jobs','service_visits','service_agreements','service_quotes')
    AND ((n->>'revision')::integer <> (o->>'revision')::integer + 1 OR (n->>'updated_at')::timestamptz < (o->>'updated_at')::timestamptz) THEN
  RAISE EXCEPTION 'The record changed since it was loaded; reload it and try again.' USING ERRCODE = '40001';
 END IF;
 immutable := CASE TG_TABLE_NAME
  WHEN 'service_requests' THEN ARRAY['id','org_id','request_number','source','portal_link_id','created_at','created_by']
  WHEN 'service_jobs' THEN ARRAY['id','org_id','job_number','request_id','agreement_id','currency','created_at','created_by']
  WHEN 'service_visits' THEN ARRAY['id','org_id','kind','request_id','job_id','sequence','agreement_id','agreement_version_id','occurs_on','created_at','created_by']
  WHEN 'service_agreements' THEN ARRAY['id','org_id','agreement_number','customer_party_id','subsidiary_id','created_at','created_by']
  WHEN 'service_quotes' THEN ARRAY['id','org_id','quote_document_id','created_at','created_by']
  WHEN 'service_visit_parts' THEN ARRAY['id','org_id','visit_id','item_id','stock_location_id','quantity','lot_id','serial_id','created_at','created_by']
  WHEN 'service_billings' THEN ARRAY['id','org_id','job_id','visit_id','invoice_document_id','created_at','created_by']
  WHEN 'service_visit_signature_requests' THEN ARRAY['id','org_id','visit_id','recipient','token_digest','expires_at','created_at','created_by']
  WHEN 'service_quote_lines' THEN ARRAY['org_id','quote_document_id','document_line_id']
  WHEN 'service_customer_notices' THEN ARRAY['id','org_id','visit_id','kind','occurrence_key','recipient','created_at','created_by']
  ELSE ARRAY['id','org_id'] END;
 IF EXISTS (SELECT 1 FROM unnest(immutable) column_name WHERE n->column_name IS DISTINCT FROM o->column_name) THEN
  RAISE EXCEPTION 'This service record keeps its identity, parent and creation evidence; create a new record instead.' USING ERRCODE = '23514';
 END IF;
 IF TG_TABLE_NAME = 'service_visit_parts' AND o->>'inventory_movement_id' IS NOT NULL THEN
  RAISE EXCEPTION 'An issued part is inventory history.' USING ERRCODE = '23514';
 END IF;
 IF TG_TABLE_NAME = 'service_job_lines' THEN
  job := (n->>'job_id')::uuid;
  SELECT status = 'open' AND NOT EXISTS (SELECT 1 FROM public.service_billings b WHERE b.org_id = tenant AND b.job_id = job AND b.released_at IS NULL)
   INTO job_open FROM public.service_jobs WHERE org_id = tenant AND id = job FOR SHARE;
  IF NOT coalesce(job_open, false) THEN
   RAISE EXCEPTION 'Job lines change only while the job is open and not yet invoiced.' USING ERRCODE = '23514';
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'service_billings' THEN
  IF o->>'released_at' IS NOT NULL OR n->>'released_at' IS NULL THEN
   RAISE EXCEPTION 'A billing link changes only when its voided invoice releases it.' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.org_id = tenant AND d.id = (n->>'invoice_document_id')::uuid AND d.status = 'voided') THEN
   RAISE EXCEPTION 'A billing link is released only after its invoice is voided; void the invoice first.' USING ERRCODE = '23514';
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'service_visit_signature_requests' AND (o->>'responded_at' IS NOT NULL OR o->>'revoked_at' IS NOT NULL) THEN
  RAISE EXCEPTION 'A used or revoked signing link is final.' USING ERRCODE = '23514';
 END IF;
 IF TG_TABLE_NAME = 'service_customer_notices' AND (o->>'status' <> 'queued' OR n->>'status' = 'queued') THEN
  RAISE EXCEPTION 'A customer notice records its delivery outcome once.' USING ERRCODE = '23514';
 END IF;
 IF TG_TABLE_NAME = 'service_quote_lines' AND o->>'selected' IS NOT NULL THEN
  RAISE EXCEPTION 'The customer''s add-on selection is final; revise the quote and send it again.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $function$;

-- Status lifecycles: a request moves forward to conversion or closure; a job
-- completes, may reopen while uninvoiced, or is cancelled; a visit follows
-- the field lifecycle.
CREATE FUNCTION public.service_status_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE live_bookings integer;
BEGIN
 IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME = 'service_requests' THEN
  IF TG_OP = 'INSERT' AND NEW.status <> 'new' THEN
   RAISE EXCEPTION 'A service request starts as new.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status = 'new' AND NEW.status IN ('assessment_scheduled','assessed','quoted','converted','declined','cancelled'))
   OR (OLD.status = 'assessment_scheduled' AND NEW.status IN ('new','assessed','quoted','converted','declined','cancelled'))
   OR (OLD.status = 'assessed' AND NEW.status IN ('quoted','converted','declined','cancelled'))
   OR (OLD.status = 'quoted' AND NEW.status IN ('assessed','converted','declined','cancelled'))) THEN
   RAISE EXCEPTION 'A service request cannot move from % to %.', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'converted' AND OLD.status <> 'converted'
     AND NOT EXISTS (SELECT 1 FROM public.service_jobs j WHERE j.org_id = NEW.org_id AND j.request_id = NEW.id) THEN
   RAISE EXCEPTION 'A request is converted by creating its service job.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME = 'service_jobs' THEN
  IF TG_OP = 'INSERT' AND NEW.status <> 'open' THEN
   RAISE EXCEPTION 'A service job starts open.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
   IF NOT ((OLD.status = 'open' AND NEW.status IN ('completed','cancelled')) OR (OLD.status = 'completed' AND NEW.status = 'open')) THEN
    RAISE EXCEPTION 'A service job cannot move from % to %.', OLD.status, NEW.status USING ERRCODE = '23514';
   END IF;
   IF NEW.status = 'completed' AND EXISTS (SELECT 1 FROM public.service_visits v WHERE v.org_id = NEW.org_id AND v.job_id = NEW.id
     AND v.status IN ('scheduled','dispatched','en_route','on_site')) THEN
    RAISE EXCEPTION 'The job still has visits in progress; complete, reschedule or cancel them first.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = 'cancelled' AND EXISTS (SELECT 1 FROM public.service_visits v WHERE v.org_id = NEW.org_id AND v.job_id = NEW.id
     AND v.status NOT IN ('unscheduled','cancelled')) THEN
    RAISE EXCEPTION 'A job with booked or worked visits is completed, not cancelled; cancel its open visits first.' USING ERRCODE = '23514';
   END IF;
   IF OLD.status = 'completed' AND NEW.status = 'open' AND EXISTS (SELECT 1 FROM public.service_billings b WHERE b.org_id = NEW.org_id
     AND b.job_id = NEW.id AND b.visit_id IS NULL AND b.released_at IS NULL) THEN
    RAISE EXCEPTION 'An invoiced job stays completed; void its invoice before reopening it.' USING ERRCODE = '23514';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 -- service_visits
 IF TG_OP = 'INSERT' THEN
  IF NEW.status NOT IN ('unscheduled') THEN
   RAISE EXCEPTION 'A visit starts unscheduled; assign it on a dispatch board.' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'service' AND NOT EXISTS (SELECT 1 FROM public.service_jobs j WHERE j.org_id = NEW.org_id AND j.id = NEW.job_id AND j.status = 'open') THEN
   RAISE EXCEPTION 'Visits are added to open jobs.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  (OLD.status = 'unscheduled' AND NEW.status IN ('scheduled','cancelled'))
  OR (OLD.status = 'scheduled' AND NEW.status IN ('unscheduled','dispatched','en_route','cancelled'))
  OR (OLD.status = 'dispatched' AND NEW.status IN ('unscheduled','scheduled','en_route','cancelled'))
  OR (OLD.status = 'en_route' AND NEW.status IN ('on_site','unable_to_complete'))
  OR (OLD.status = 'on_site' AND NEW.status IN ('completed','unable_to_complete'))
  OR (OLD.status = 'completed' AND NEW.status = 'on_site' AND NEW.review_status IS NULL AND OLD.review_status = 'rejected')) THEN
  RAISE EXCEPTION 'A visit cannot move from % to %.', OLD.status, NEW.status USING ERRCODE = '23514';
 END IF;
 IF NEW.status IN ('scheduled','dispatched','en_route','on_site','unscheduled') AND NEW.status IS DISTINCT FROM OLD.status THEN
  SELECT count(*) INTO live_bookings FROM public.schedule_entries e
   WHERE e.org_id = NEW.org_id AND e.service_visit_id = NEW.id AND e.status = 'published';
  IF NEW.status = 'unscheduled' AND live_bookings > 0 THEN
   RAISE EXCEPTION 'An unscheduled visit holds no bookings; remove its technicians first.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'unscheduled' AND live_bookings = 0 THEN
   RAISE EXCEPTION 'A scheduled visit is booked on at least one technician.' USING ERRCODE = '23514';
  END IF;
 END IF;
 IF OLD.status IN ('completed','unable_to_complete','cancelled') AND NEW.status = OLD.status
    AND to_jsonb(NEW) - ARRAY['review_status','review_flow_run_id','review_decided_by','review_decided_at','review_reason','revision','updated_at','updated_by']
     IS DISTINCT FROM to_jsonb(OLD) - ARRAY['review_status','review_flow_run_id','review_decided_by','review_decided_at','review_reason','revision','updated_at','updated_by'] THEN
  RAISE EXCEPTION 'A finished visit is history; only its completion review is recorded.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $function$;

-- Append-only service history: versions, lines of versions, status events,
-- policies, notices and signatures are never rewritten or deleted.
CREATE FUNCTION public.service_history_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Service history cannot be deleted.' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'Service history is append-only; record a new version or event instead.' USING ERRCODE = '23514';
 END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME = 'service_agreement_lines' AND EXISTS (SELECT 1 FROM public.service_visits v
   WHERE v.org_id = NEW.org_id AND v.agreement_version_id = (to_jsonb(NEW)->>'version_id')::uuid) THEN
  RAISE EXCEPTION 'An agreement version that generated visits keeps its lines; add a new version instead.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $function$;

DO $block$ DECLARE target record; BEGIN
 FOR target IN SELECT * FROM (VALUES
  ('service_dispatch_policies','service_history_guard'),
  ('service_requests','service_record_guard'),
  ('service_agreements','service_record_guard'),
  ('service_agreement_versions','service_history_guard'),
  ('service_agreement_lines','service_history_guard'),
  ('service_jobs','service_record_guard'),
  ('service_job_lines','service_record_guard'),
  ('service_quotes','service_record_guard'),
  ('service_quote_lines','service_record_guard'),
  ('service_visits','service_record_guard'),
  ('service_visit_events','service_history_guard'),
  ('service_visit_parts','service_record_guard'),
  ('service_visit_signature_requests','service_record_guard'),
  ('service_visit_signatures','service_history_guard'),
  ('service_billings','service_record_guard'),
  ('service_job_deposits','service_history_guard'),
  ('service_customer_notices','service_record_guard')
 ) AS expected(table_name, guard) LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', target.guard, target.table_name, target.guard);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true))) WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true)))', target.table_name);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''', target.table_name);
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', target.table_name);
 END LOOP;
 FOREACH target.table_name IN ARRAY ARRAY['service_requests','service_jobs','service_visits'] LOOP
  EXECUTE format('CREATE TRIGGER service_status_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.service_status_guard()', target.table_name);
 END LOOP;
END $block$;

-- Built-in roles: administrators gain every service grant and controllers
-- the read and manage grants; every organization gains the Service
-- Dispatcher and Field Technician roles. A custom role already using one of
-- those keys is left exactly as configured.
UPDATE public.app_roles SET permissions = permissions || '["service.read"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key IN ('admin', 'controller')
   AND NOT (permissions ? 'service.read' OR permissions ? 'service.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["service.manage"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key IN ('admin', 'controller')
   AND NOT (permissions ? 'service.manage' OR permissions ? 'service.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["service.dispatch"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key IN ('admin')
   AND NOT (permissions ? 'service.dispatch' OR permissions ? 'service.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["service.self"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key IN ('admin')
   AND NOT (permissions ? 'service.self' OR permissions ? 'service.*' OR permissions ? '*');
INSERT INTO public.app_roles (org_id, key, name, description, is_built_in, permissions)
SELECT o.id, 'dispatcher', 'Service Dispatcher', 'Takes service requests, quotes and prices service jobs and agreements, and assigns and reschedules visits on dispatch boards. Logs their own time and files their own expense reports. Cannot invoice, take payments or see banking or the ledger.', true, '["service.read", "service.manage", "service.dispatch", "estimates.read", "estimates.create", "estimates.issue", "parties.read", "items.read", "reports.read", "time.self", "time.clock", "expenses.self", "documents.read", "feedback.use", "assistant.use", "hrm.self.read", "hrm.self.request", "hrm.leave.request"]'::jsonb
  FROM public.orgs o
 WHERE NOT EXISTS (SELECT 1 FROM public.app_roles r WHERE r.org_id = o.id AND r.key = 'dispatcher');
INSERT INTO public.app_roles (org_id, key, name, description, is_built_in, permissions)
SELECT o.id, 'field_technician', 'Field Technician', 'Sees and works only the service visits booked on them: updates their field status, records work notes, parts and labor, and collects the customer''s signature. Logs their own time and files their own expense reports. Cannot see other technicians'' visits, prices, invoices or the ledger.', true, '["service.self", "items.read", "time.self", "time.clock", "expenses.self", "feedback.use", "hrm.self.read", "hrm.self.request", "hrm.leave.request"]'::jsonb
  FROM public.orgs o
 WHERE NOT EXISTS (SELECT 1 FROM public.app_roles r WHERE r.org_id = o.id AND r.key = 'field_technician');

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('service_dispatch_policies', '0751_service_dispatch'),
 ('service_requests', '0751_service_dispatch'),
 ('service_agreements', '0751_service_dispatch'),
 ('service_agreement_versions', '0751_service_dispatch'),
 ('service_agreement_lines', '0751_service_dispatch'),
 ('service_jobs', '0751_service_dispatch'),
 ('service_job_lines', '0751_service_dispatch'),
 ('service_quotes', '0751_service_dispatch'),
 ('service_quote_lines', '0751_service_dispatch'),
 ('service_visits', '0751_service_dispatch'),
 ('service_visit_events', '0751_service_dispatch'),
 ('service_visit_parts', '0751_service_dispatch'),
 ('service_visit_signatures', '0751_service_dispatch'),
 ('service_billings', '0751_service_dispatch'),
 ('service_job_deposits', '0751_service_dispatch')
ON CONFLICT (relation) DO NOTHING; -- expected on replay; the registry seed is idempotent

SELECT public.openbooks_refresh_query_catalog();
