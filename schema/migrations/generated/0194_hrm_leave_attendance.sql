-- OpenBooks forward migration 0194_hrm_leave_attendance.
--
-- HR-5 leave and attendance (HR records) and the signed-off pay-run input
-- queue. THE SEAM WITH PAYROLL, binding: leave types, policies, requests,
-- approvals and the absence record are HR records; the payroll entitlement
-- ledger (movement kinds opening, accrual, bank_in, payout, repayment,
-- adjustment, written ONLY by a pay run inside its transaction) never learns
-- the concept of leave and HR NEVER writes a movement. Only two things
-- cross — a payout (vacation paid out of a bank) and a bank_in (time banked
-- in lieu) — and they cross as PAY-RUN INPUTS that the run reads when it
-- computes, never as ledger writes. There is no taken movement kind and
-- none is added here; an absence that is unpaid or paid from salary never
-- touches the ledger.
--
-- The policy below is HR's entitlement in TIME; it is not the payroll bank
-- in VALUE, and the two are never conflated in code or copy.
--
-- hrm_payroll_inputs carries NO amount column. HR sends hours; the run
-- resolves the rate. Storing an amount here would let a stale rate pay a
-- live day, so the column must not exist — not null, not zero, absent.
--
-- Tables (all org-scoped, all under the org_isolation RLS below):
--   hrm_leave_types      taxonomy owned by HR, org-configurable, country-agnostic.
--   hrm_leave_policies   time entitlement per type with applies_to scoping and
--                        effective dating.
--   hrm_leave_requests   lifecycle draft/submitted/approved/rejected/withdrawn/
--                        cancelled with a no-overlap exclusion per employment
--                        for approved requests.
--   hrm_absences         the immutable absence record per day; corrections are
--                        reversing rows (negative hours via reversal_of), never
--                        updates.
--   hrm_payroll_inputs   ONE ROW PER ABSENCE DAY for types whose value_crossing
--                        is payout or bank_in. A request spanning a pay-period
--                        or tax-year boundary splits by the fact (one row per
--                        day), never by a computed boundary.
--
-- hrm_payroll_inputs columns: employee_party_id is the key the ledger reads,
-- resolved by HR from the employment at write time; employment_id is
-- provenance only. The two are NEVER interchangeable: the run scopes by the
-- party through its stubs, and the employment row is how an operator traces
-- the input back to the worker. unique (org_id, source_leave_request_id,
-- absence_date) makes a retried approval land on the same rows.
--
-- consumed_by_run_document_id is the ONLY link back to a stale run, so
-- voiding NEVER clears it: a request cancelled after calculation leaves the
-- consumed row voided-but-linked, and the commit gate (which reads pending
-- rows only) would otherwise go blind to the stale calculation. The guard
-- trigger below refuses any update that clears it.
--
-- Deletes: submitted requests, absences, and payroll inputs are retained
-- history. Only pure-draft requests may be discarded. The governed amend
-- path (openbooks.amend = on: fixture teardown, sandbox wipe, org purge)
-- is honoured so a leave row can never pin its organisation; production
-- paths never set that GUC.
--
-- Additive only. Alters no payroll table, performs no backfill, exposes
-- nothing to the generic governed-query catalog.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_leave_types (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    paid boolean NOT NULL DEFAULT true,
    -- Which of the two allowed pay-run input movements this type raises, if
    -- any: none (unpaid or paid from salary — never touches the ledger),
    -- payout, or bank_in. There is no taken kind.
    value_crossing text NOT NULL DEFAULT 'none',
    requires_attachment boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_leave_types_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_leave_types_code CHECK (char_length(btrim(code)) > 0),
    CONSTRAINT hrm_leave_types_name CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_leave_types_value_crossing CHECK (value_crossing IN ('none', 'payout', 'bank_in'))
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_leave_types_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_leave_types ADD CONSTRAINT hrm_leave_types_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_leave_types_org_code_unique') THEN
  ALTER TABLE ONLY public.hrm_leave_types ADD CONSTRAINT hrm_leave_types_org_code_unique UNIQUE (org_id, code); END IF; END $$;

CREATE TABLE IF NOT EXISTS public.hrm_leave_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    leave_type_id uuid NOT NULL,
    -- Scoping: {"employer_subsidiary_id": uuid|null, "department_id": uuid|null}.
    -- Null pins mean org-wide. Overlaps are resolved service-side by
    -- specificity; storage carries the declaration, never the resolution.
    applies_to jsonb NOT NULL DEFAULT '{"employer_subsidiary_id": null, "department_id": null}'::jsonb,
    -- Accrual rule declared by the org: {"kind": "none"|"per_period"|"per_year"|"unlimited",
    -- "hours": "decimal-string"}. Hours are decimal STRINGS (never floats);
    -- the service parses them as exact decimals.
    accrual_rule jsonb NOT NULL DEFAULT '{"kind": "none"}'::jsonb,
    -- Carryover rule: {"kind": "none"|"carry_all"|"carry_up_to", "hours": "decimal-string"|null,
    -- "expires_after_days": integer|null}.
    carryover_rule jsonb NOT NULL DEFAULT '{"kind": "none"}'::jsonb,
    minimum_notice_days integer NOT NULL DEFAULT 0,
    effective_from date NOT NULL,
    effective_to date,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_leave_policies_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_leave_policies_notice CHECK (minimum_notice_days >= 0),
    CONSTRAINT hrm_leave_policies_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT hrm_leave_policies_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    )
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_leave_policies_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_leave_policies ADD CONSTRAINT hrm_leave_policies_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

CREATE TABLE IF NOT EXISTS public.hrm_leave_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    leave_type_id uuid NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    hours numeric(9,2) NOT NULL,
    reason text,
    status text NOT NULL DEFAULT 'draft',
    decided_by uuid,
    decided_at timestamp with time zone,
    decision_reason text,
    flow_instance_id uuid,
    attachment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_leave_requests_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_leave_requests_range CHECK (ends_on >= starts_on),
    CONSTRAINT hrm_leave_requests_hours CHECK (hours > 0),
    CONSTRAINT hrm_leave_requests_status CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'withdrawn', 'cancelled')),
    CONSTRAINT hrm_leave_requests_finite_time CHECK (
      starts_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND ends_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    ,
    -- Decided states carry who decided, when, and why; undecided states
    -- carry none of them. Null-safe: each nullable participant is explicit
    -- so UNKNOWN cannot smuggle a half-decision past the CHECK.
    CONSTRAINT hrm_leave_requests_decision CHECK (
      ((status IN ('approved', 'rejected')) AND decided_by IS NOT NULL AND decided_at IS NOT NULL
        AND decision_reason IS NOT NULL AND char_length(btrim(decision_reason)) > 0)
      OR ((status IN ('draft', 'submitted', 'withdrawn', 'cancelled')) AND decided_by IS NULL AND decided_at IS NULL)
    )
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_leave_requests_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_leave_requests ADD CONSTRAINT hrm_leave_requests_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- No-overlap exclusion per employment for APPROVED requests: two approved
-- requests of one employment never cover the same day. Drafts, submissions
-- and terminal non-approved rows overlap freely (the service refuses a
-- submit that overlaps an approval; the exclusion is the storage backstop
-- for concurrent approvals). daterange with '[]' bounds is day-inclusive on
-- both ends so a shared boundary day still collides.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_leave_requests_approved_no_overlap') THEN
  ALTER TABLE ONLY public.hrm_leave_requests ADD CONSTRAINT hrm_leave_requests_approved_no_overlap
    EXCLUDE USING gist (org_id WITH =, employment_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
    WHERE (status = 'approved'); END IF; END $$;

CREATE TABLE IF NOT EXISTS public.hrm_absences (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    leave_request_id uuid,
    employment_id uuid NOT NULL,
    on_date date NOT NULL,
    hours numeric(9,2) NOT NULL,
    leave_type_id uuid NOT NULL,
    -- request = written when a request is approved; recorded = recorded after
    -- the fact. A reversal is a further row with negative hours pointing at
    -- the row it reverses — never an update, never a delete.
    source text NOT NULL,
    reversal_of uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_absences_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_absences_hours CHECK (hours <> 0),
    CONSTRAINT hrm_absences_source CHECK (source IN ('request', 'recorded')),
    CONSTRAINT hrm_absences_reversal CHECK (
      (reversal_of IS NULL AND hours > 0)
      OR (reversal_of IS NOT NULL AND hours < 0)
    ),
    CONSTRAINT hrm_absences_finite_time CHECK (
      on_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    )
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_absences_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_absences ADD CONSTRAINT hrm_absences_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
-- One row per request-day: a retried approval lands on the same days.
-- (Partial unique indexes live in pg_index, not pg_constraint, so the
-- idempotence check is IF NOT EXISTS on the index itself.)
CREATE UNIQUE INDEX IF NOT EXISTS hrm_absences_request_day_unique ON public.hrm_absences (org_id, leave_request_id, on_date)
  WHERE leave_request_id IS NOT NULL;
-- After-the-fact rows carry no request: one per employment-day.
CREATE UNIQUE INDEX IF NOT EXISTS hrm_absences_recorded_day_unique ON public.hrm_absences (org_id, employment_id, on_date)
  WHERE leave_request_id IS NULL AND reversal_of IS NULL;
CREATE INDEX IF NOT EXISTS hrm_absences_employment_day ON public.hrm_absences (org_id, employment_id, on_date);
CREATE INDEX IF NOT EXISTS hrm_absences_reversal_of ON public.hrm_absences (org_id, reversal_of) WHERE reversal_of IS NOT NULL;

-- The pay-run input queue. ONE ROW PER ABSENCE DAY for types whose
-- value_crossing is payout or bank_in. HR sends HOURS; the run resolves the
-- rate. There is deliberately NO amount column here: storing an amount would
-- let a stale rate pay a live day. See the header comment.
CREATE TABLE IF NOT EXISTS public.hrm_payroll_inputs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    -- THE key the ledger reads, resolved by HR from the employment at write
    -- time. employment_id below is provenance only; the two are NEVER
    -- interchangeable (the run scopes by the party through its stubs).
    employee_party_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    kind text NOT NULL,
    absence_date date NOT NULL,
    hours numeric(9,2) NOT NULL,
    source_leave_request_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    consumed_by_run_document_id uuid,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_payroll_inputs_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_payroll_inputs_kind CHECK (kind IN ('payout', 'bank_in')),
    CONSTRAINT hrm_payroll_inputs_hours CHECK (hours > 0),
    CONSTRAINT hrm_payroll_inputs_status CHECK (status IN ('pending', 'consumed', 'voided')),
    CONSTRAINT hrm_payroll_inputs_finite_time CHECK (
      absence_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    ),
    -- Consumed rows name their run; pending rows name none. Voided rows KEEP
    -- whatever run they named (the only link back to the stale run) — the
    -- guard below refuses any update that clears it.
    CONSTRAINT hrm_payroll_inputs_consumed_link CHECK (
      (status = 'consumed' AND consumed_by_run_document_id IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status = 'pending' AND consumed_by_run_document_id IS NULL AND consumed_at IS NULL)
      OR (status = 'voided')
    )
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_payroll_inputs_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_payroll_inputs ADD CONSTRAINT hrm_payroll_inputs_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_payroll_inputs_source_day_unique') THEN
  ALTER TABLE ONLY public.hrm_payroll_inputs ADD CONSTRAINT hrm_payroll_inputs_source_day_unique
    UNIQUE (org_id, source_leave_request_id, absence_date); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_payroll_inputs_party_day ON public.hrm_payroll_inputs (org_id, employee_party_id, absence_date);
CREATE INDEX IF NOT EXISTS hrm_payroll_inputs_run ON public.hrm_payroll_inputs (org_id, consumed_by_run_document_id) WHERE consumed_by_run_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hrm_payroll_inputs_status ON public.hrm_payroll_inputs (org_id, status);

-- ---------------------------------------------------------------------------
-- Tenant-coherent foreign keys (all deferrable, so a whole-org teardown
-- transaction completes; 0188 precedent).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_leave_policies_type_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_leave_policies ADD CONSTRAINT hrm_leave_policies_type_tenant_fkey
    FOREIGN KEY (org_id, leave_type_id) REFERENCES public.hrm_leave_types (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_leave_requests_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_leave_requests ADD CONSTRAINT hrm_leave_requests_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_leave_requests_type_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_leave_requests ADD CONSTRAINT hrm_leave_requests_type_tenant_fkey
    FOREIGN KEY (org_id, leave_type_id) REFERENCES public.hrm_leave_types (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_absences_request_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_absences ADD CONSTRAINT hrm_absences_request_tenant_fkey
    FOREIGN KEY (org_id, leave_request_id) REFERENCES public.hrm_leave_requests (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_absences_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_absences ADD CONSTRAINT hrm_absences_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_absences_type_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_absences ADD CONSTRAINT hrm_absences_type_tenant_fkey
    FOREIGN KEY (org_id, leave_type_id) REFERENCES public.hrm_leave_types (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_payroll_inputs_request_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_payroll_inputs ADD CONSTRAINT hrm_payroll_inputs_request_tenant_fkey
    FOREIGN KEY (org_id, source_leave_request_id) REFERENCES public.hrm_leave_requests (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_payroll_inputs_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_payroll_inputs ADD CONSTRAINT hrm_payroll_inputs_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
-- employee_party_id is the key the ledger reads. The tenant FK keeps it
-- coherent and enrolls the column in the audited party-merge path (SIMPLE:
-- re-pointing the party cannot collide — the uniqueness here is
-- (org, request, day), which carries no party column).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_payroll_inputs_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_payroll_inputs ADD CONSTRAINT hrm_payroll_inputs_party_tenant_fkey
    FOREIGN KEY (org_id, employee_party_id) REFERENCES public.parties (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

-- Absences are immutable evidence: corrections are reversing rows, never
-- updates. Deletes are admitted only on the governed amend path (fixture
-- teardown, sandbox wipe, org purge); production paths never set that GUC.
CREATE OR REPLACE FUNCTION public.hrm_absence_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'HRM absence % is immutable evidence — record a reversing absence row instead of updating it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_absence_immutable_trigger ON public.hrm_absences;
CREATE TRIGGER hrm_absence_immutable_trigger
  BEFORE UPDATE ON public.hrm_absences
  FOR EACH ROW EXECUTE FUNCTION public.hrm_absence_immutable_guard();

CREATE OR REPLACE FUNCTION public.hrm_absence_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM absence % is retained as history — record a reversing absence row instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_absence_no_delete_trigger ON public.hrm_absences;
CREATE TRIGGER hrm_absence_no_delete_trigger
  BEFORE DELETE ON public.hrm_absences
  FOR EACH ROW EXECUTE FUNCTION public.hrm_absence_no_delete();

-- Voiding NEVER clears consumed_by_run_document_id: it is the only link
-- back to the stale run, and the commit gate reads pending rows only. A
-- void that clears the link would make a stale calculation invisible.
CREATE OR REPLACE FUNCTION public.hrm_payroll_input_void_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.status = 'voided' AND OLD.consumed_by_run_document_id IS NOT NULL
     AND NEW.consumed_by_run_document_id IS DISTINCT FROM OLD.consumed_by_run_document_id THEN
    RAISE EXCEPTION
      'HRM payroll input % was consumed by pay run % — voiding keeps that link so the stale run stays visible; recalculate the run instead of unlinking it.',
      OLD.id, OLD.consumed_by_run_document_id;
  END IF;
  IF NEW.status = 'pending' AND OLD.status = 'voided' THEN
    RAISE EXCEPTION
      'HRM payroll input % is voided and stays voided — release never resurrects a voided row; file a new request for a revised absence.',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_payroll_input_void_guard_trigger ON public.hrm_payroll_inputs;
CREATE TRIGGER hrm_payroll_input_void_guard_trigger
  BEFORE UPDATE ON public.hrm_payroll_inputs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_payroll_input_void_guard();

-- Submitted leave requests are retained history; pure drafts may be
-- discarded. Amend path honoured so a request can never pin its org.
CREATE OR REPLACE FUNCTION public.hrm_leave_request_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION
      'HRM leave request % left draft and is retained as history — withdraw or cancel it instead of deleting it.', OLD.id;
  END IF;
  RETURN OLD;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_leave_request_no_delete_trigger ON public.hrm_leave_requests;
CREATE TRIGGER hrm_leave_request_no_delete_trigger
  BEFORE DELETE ON public.hrm_leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.hrm_leave_request_no_delete();

CREATE OR REPLACE FUNCTION public.hrm_payroll_input_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM payroll input % is retained as history — void it instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_payroll_input_no_delete_trigger ON public.hrm_payroll_inputs;
CREATE TRIGGER hrm_payroll_input_no_delete_trigger
  BEFORE DELETE ON public.hrm_payroll_inputs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_payroll_input_no_delete();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0184/0185 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all five tables. Leave stays out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_leave_types', 'hrm_leave_policies',
    'hrm_leave_requests', 'hrm_absences',
    'hrm_payroll_inputs'] LOOP
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

COMMENT ON TABLE public.hrm_leave_types IS
  'HRM leave-type taxonomy (0194): org-configurable, country-agnostic. value_crossing names which of the two allowed pay-run input movements (payout, bank_in) this type raises, or none. No pack declares leave types; this table is the single source of truth.';
COMMENT ON COLUMN public.hrm_leave_types.value_crossing IS
  'Which allowed movement this type raises as a pay-run input (none, payout, bank_in). There is no taken movement kind; unpaid or salary-paid absence never touches the ledger.';
COMMENT ON TABLE public.hrm_leave_policies IS
  'HRM leave policies (0194): HR entitlement in TIME per type, with applies_to scoping and effective dating. This is not the payroll bank in VALUE; the two are never conflated.';
COMMENT ON TABLE public.hrm_leave_requests IS
  'HRM leave requests (0194): lifecycle draft/submitted/approved/rejected/withdrawn/cancelled. Approved requests never overlap per employment (storage exclusion); the service refuses overlapping submits first.';
COMMENT ON TABLE public.hrm_absences IS
  'HRM immutable absence record per day (0194): written when a request is approved or recorded after the fact. Corrections are reversing rows (negative hours via reversal_of), never updates; deletes only on the governed amend path.';
COMMENT ON TABLE public.hrm_payroll_inputs IS
  'HRM pay-run input queue (0194): ONE ROW PER ABSENCE DAY for payout/bank_in types. HR sends HOURS only — there is deliberately NO amount column; the run resolves the rate. employee_party_id is the key the ledger reads; employment_id is provenance only and the two are never interchangeable. unique (org_id, source_leave_request_id, absence_date). Voiding never clears consumed_by_run_document_id (the only link back to the stale run).';
