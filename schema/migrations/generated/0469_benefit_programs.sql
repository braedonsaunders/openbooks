-- OpenBooks forward migration 0469_benefit_programs.
--
-- Employer-defined benefit programs (rewards, allowances, incentives, custom)
-- stored separately from insured benefit plans (hrm_benefit_plans, unchanged
-- and authoritative for health and retirement). A program header carries typed
-- rule columns (family, delivery, valuation, metric, scope, allocation,
-- amounts, frequency, payment delay) with no mutable JSON rules; measurement
-- scope is a typed child table resolving departments and projects through
-- tenant keys; funding sources are a typed child table; membership binds
-- employments over effective dates; awards record each issuance with
-- immutable program and source snapshots plus evidence, lifecycle status,
-- and payroll or external linkage. History is preserved: programs close
-- rather than delete, awards void rather than delete, events are append-only.
--
-- Additive only. Alters no existing table except enrolling new tenant FK
-- parents in their (org_id, id) uniques. Performs no backfill.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Tenant-FK parent enrollment (additive): the (org_id, id) uniques new
-- tenant FKs need. Pay components, subsidiaries, accounts, employments, and
-- benefit payroll inputs already carry theirs from earlier migrations; enroll
-- only what is missing.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'accounts_org_id_id_unique') THEN
  ALTER TABLE ONLY public.accounts ADD CONSTRAINT accounts_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'subsidiaries_org_id_id_unique') THEN
  ALTER TABLE ONLY public.subsidiaries ADD CONSTRAINT subsidiaries_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'worker_employments_org_id_id_unique') THEN
  ALTER TABLE ONLY public.worker_employments ADD CONSTRAINT worker_employments_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_benefit_programs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    family text NOT NULL,
    description text,
    legal_entity_id uuid,
    currency char(3) NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    effective_from date NOT NULL,
    effective_to date,
    pay_component_id uuid,
    delivery_method text NOT NULL DEFAULT 'payroll',
    valuation text NOT NULL DEFAULT 'fixed',
    metric text,
    metric_scope text,
    allocation text NOT NULL DEFAULT 'equal',
    percent_rate numeric(19,4),
    fixed_amount numeric(19,4),
    cap_amount numeric(19,4),
    budget_amount numeric(19,4),
    threshold_amount numeric(19,4),
    frequency text NOT NULL DEFAULT 'manual',
    period_basis text,
    payment_delay_days integer NOT NULL DEFAULT 0,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_programs_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_programs_code CHECK (char_length(btrim(code)) > 0),
    CONSTRAINT hrm_benefit_programs_name CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_benefit_programs_family CHECK (family IN ('reward', 'allowance', 'incentive', 'custom')),
    CONSTRAINT hrm_benefit_programs_status CHECK (status IN ('draft', 'active', 'closed')),
    CONSTRAINT hrm_benefit_programs_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT hrm_benefit_programs_delivery CHECK (delivery_method IN ('payroll', 'external')),
    CONSTRAINT hrm_benefit_programs_valuation CHECK (valuation IN ('fixed', 'percent', 'pool')),
    CONSTRAINT hrm_benefit_programs_metric CHECK (metric IS NULL OR metric IN ('revenue', 'gross_profit', 'net_profit', 'approved_hours')),
    CONSTRAINT hrm_benefit_programs_scope CHECK (metric_scope IS NULL OR metric_scope IN ('company', 'department', 'project')),
    CONSTRAINT hrm_benefit_programs_allocation CHECK (allocation IN ('equal', 'hours', 'role')),
    CONSTRAINT hrm_benefit_programs_frequency CHECK (frequency IN ('monthly', 'quarterly', 'annual', 'project_complete', 'manual')),
    CONSTRAINT hrm_benefit_programs_period_basis CHECK (period_basis IS NULL OR period_basis IN ('calendar', 'fiscal')),
    CONSTRAINT hrm_benefit_programs_period_basis_required CHECK (
      frequency NOT IN ('quarterly', 'annual') OR period_basis IS NOT NULL),
    CONSTRAINT hrm_benefit_programs_amounts CHECK (
      (percent_rate IS NULL OR percent_rate >= 0)
      AND (fixed_amount IS NULL OR fixed_amount >= 0)
      AND (cap_amount IS NULL OR cap_amount >= 0)
      AND (budget_amount IS NULL OR budget_amount >= 0)
      AND (threshold_amount IS NULL OR threshold_amount >= 0)),
    CONSTRAINT hrm_benefit_programs_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT hrm_benefit_programs_delay CHECK (payment_delay_days >= 0),
    CONSTRAINT hrm_benefit_programs_revision CHECK (revision >= 1),
    CONSTRAINT hrm_benefit_programs_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')),
    CONSTRAINT hrm_benefit_programs_incentive_metric CHECK (
      family <> 'incentive' OR metric IS NOT NULL),
    CONSTRAINT hrm_benefit_programs_external_component CHECK (
      delivery_method <> 'external' OR pay_component_id IS NULL OR family IN ('reward', 'allowance', 'custom'))
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_programs_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_programs_org_code_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_org_code_unique UNIQUE (org_id, code); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_programs_org ON public.hrm_benefit_programs (org_id);
CREATE INDEX IF NOT EXISTS hrm_benefit_programs_status ON public.hrm_benefit_programs (org_id, status);

CREATE TABLE IF NOT EXISTS public.hrm_benefit_program_scopes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    program_id uuid NOT NULL,
    department_id uuid,
    project_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_program_scopes_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_program_scopes_one_entity CHECK (
      (department_id IS NOT NULL)::int + (project_id IS NOT NULL)::int = 1)
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_scopes_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_scopes ADD CONSTRAINT hrm_benefit_program_scopes_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_program_scopes_program ON public.hrm_benefit_program_scopes (org_id, program_id);

CREATE TABLE IF NOT EXISTS public.hrm_benefit_program_sources (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    program_id uuid NOT NULL,
    account_id uuid NOT NULL,
    weight_bps integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_program_sources_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_program_sources_weight CHECK (weight_bps IS NULL OR (weight_bps >= 0 AND weight_bps <= 10000))
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_sources_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_sources ADD CONSTRAINT hrm_benefit_program_sources_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_sources_org_program_account_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_sources ADD CONSTRAINT hrm_benefit_program_sources_org_program_account_unique UNIQUE (org_id, program_id, account_id); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_program_sources_program ON public.hrm_benefit_program_sources (org_id, program_id);

CREATE TABLE IF NOT EXISTS public.hrm_benefit_program_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    program_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    weight numeric(19,4),
    role text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_program_members_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_program_members_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT hrm_benefit_program_members_weight CHECK (weight IS NULL OR weight >= 0),
    CONSTRAINT hrm_benefit_program_members_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'))
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_members_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_members ADD CONSTRAINT hrm_benefit_program_members_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
-- UUID equality operator classes are supplied by btree_gist (0024 precedent).
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_members_window_exclusion') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_members ADD CONSTRAINT hrm_benefit_program_members_window_exclusion
  EXCLUDE USING gist (
    org_id WITH =,
    program_id WITH =,
    employment_id WITH =,
    (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
  ); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_program_members_program ON public.hrm_benefit_program_members (org_id, program_id);
CREATE INDEX IF NOT EXISTS hrm_benefit_program_members_employment ON public.hrm_benefit_program_members (org_id, employment_id);

CREATE TABLE IF NOT EXISTS public.hrm_benefit_awards (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    program_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    period_from date NOT NULL,
    period_to date,
    value numeric(19,4) NOT NULL,
    currency char(3) NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    program_snapshot jsonb NOT NULL,
    source_snapshot jsonb NOT NULL,
    evidence jsonb,
    source_key text,
    adjusts_award_id uuid,
    external_ref text,
    pay_run_document_id uuid,
    pay_run_adjustment_id uuid,
    approved_by uuid,
    approved_at timestamp with time zone,
    void_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_awards_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_awards_status CHECK (status IN ('draft', 'pending', 'approved', 'queued', 'delivered', 'voided')),
    CONSTRAINT hrm_benefit_awards_value CHECK (value >= 0 OR adjusts_award_id IS NOT NULL),
    CONSTRAINT hrm_benefit_awards_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT hrm_benefit_awards_window CHECK (period_to IS NULL OR period_to >= period_from),
    CONSTRAINT hrm_benefit_awards_snapshots CHECK (jsonb_typeof(program_snapshot) = 'object' AND jsonb_typeof(source_snapshot) = 'object'),
    CONSTRAINT hrm_benefit_awards_evidence CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object'),
    CONSTRAINT hrm_benefit_awards_finite_time CHECK (
      period_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (period_to IS NULL OR period_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'))
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_awards_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_awards ADD CONSTRAINT hrm_benefit_awards_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_awards_org_program_source_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_awards ADD CONSTRAINT hrm_benefit_awards_org_program_source_unique UNIQUE (org_id, program_id, source_key); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_awards_program ON public.hrm_benefit_awards (org_id, program_id);
CREATE INDEX IF NOT EXISTS hrm_benefit_awards_employment ON public.hrm_benefit_awards (org_id, employment_id);
CREATE INDEX IF NOT EXISTS hrm_benefit_awards_status ON public.hrm_benefit_awards (org_id, status);

CREATE TABLE IF NOT EXISTS public.hrm_benefit_award_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    award_id uuid NOT NULL,
    kind text NOT NULL,
    reason text NOT NULL,
    actor uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT hrm_benefit_award_events_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_award_events_kind CHECK (kind IN ('created', 'submitted', 'approved', 'queued', 'delivered', 'external_delivered', 'voided')),
    CONSTRAINT hrm_benefit_award_events_reason CHECK (char_length(btrim(reason)) > 0)
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_award_events_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_award_events ADD CONSTRAINT hrm_benefit_award_events_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_award_events_award ON public.hrm_benefit_award_events (org_id, award_id);

-- ---------------------------------------------------------------------------
-- Tenant-coherent foreign keys (all deferrable, so a whole-org teardown
-- transaction completes; 0188 precedent).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_programs_subsidiary_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_subsidiary_tenant_fkey
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES public.subsidiaries (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_programs_component_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_component_tenant_fkey
    FOREIGN KEY (org_id, pay_component_id) REFERENCES public.pay_components (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_scopes_program_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_scopes ADD CONSTRAINT hrm_benefit_program_scopes_program_tenant_fkey
    FOREIGN KEY (org_id, program_id) REFERENCES public.hrm_benefit_programs (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_scopes_department_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_scopes ADD CONSTRAINT hrm_benefit_program_scopes_department_tenant_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_scopes_project_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_scopes ADD CONSTRAINT hrm_benefit_program_scopes_project_tenant_fkey
    FOREIGN KEY (org_id, project_id) REFERENCES public.projects (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_sources_program_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_sources ADD CONSTRAINT hrm_benefit_program_sources_program_tenant_fkey
    FOREIGN KEY (org_id, program_id) REFERENCES public.hrm_benefit_programs (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_sources_account_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_sources ADD CONSTRAINT hrm_benefit_program_sources_account_tenant_fkey
    FOREIGN KEY (org_id, account_id) REFERENCES public.accounts (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_members_program_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_members ADD CONSTRAINT hrm_benefit_program_members_program_tenant_fkey
    FOREIGN KEY (org_id, program_id) REFERENCES public.hrm_benefit_programs (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_members_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_members ADD CONSTRAINT hrm_benefit_program_members_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_awards_program_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_awards ADD CONSTRAINT hrm_benefit_awards_program_tenant_fkey
    FOREIGN KEY (org_id, program_id) REFERENCES public.hrm_benefit_programs (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_awards_adjusts_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_awards ADD CONSTRAINT hrm_benefit_awards_adjusts_tenant_fkey
    FOREIGN KEY (org_id, adjusts_award_id) REFERENCES public.hrm_benefit_awards (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_awards_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_awards ADD CONSTRAINT hrm_benefit_awards_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

-- Award financial identity is immutable evidence: program and source
-- snapshots, subject, period, value, currency, idempotency key, and pay
-- linkage never rewrite. Evidence freezes once the award leaves draft:
-- drafts record proof, approvals rely on it. Delivery writes the external
-- reference and pay linkage during the queued-to-delivered move only; after
-- delivery everything but the lifecycle status freezes. A delivered award is
-- never voided — a correction is an adjusting award, never a rewrite.
CREATE OR REPLACE FUNCTION public.hrm_benefit_award_snapshot_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.program_snapshot IS DISTINCT FROM OLD.program_snapshot
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.period_from IS DISTINCT FROM OLD.period_from
     OR NEW.period_to IS DISTINCT FROM OLD.period_to
     OR NEW.value IS DISTINCT FROM OLD.value
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.source_key IS DISTINCT FROM OLD.source_key THEN
    IF OLD.status = 'delivered' THEN
      RAISE EXCEPTION
        'HRM benefit award % is delivered history — issue an adjusting award instead of rewriting it.', OLD.id;
    END IF;
    RAISE EXCEPTION
      'HRM benefit award % carries immutable program and source snapshots — void it and issue a new award instead of rewriting it.', OLD.id;
  END IF;
  IF OLD.status IN ('approved', 'queued', 'delivered', 'voided')
     AND NEW.evidence IS DISTINCT FROM OLD.evidence THEN
    RAISE EXCEPTION
      'HRM benefit award % evidence froze at approval — void it and issue a new award instead of rewriting the proof.', OLD.id;
  END IF;
  IF (NEW.external_ref IS DISTINCT FROM OLD.external_ref
      OR NEW.pay_run_document_id IS DISTINCT FROM OLD.pay_run_document_id
      OR NEW.pay_run_adjustment_id IS DISTINCT FROM OLD.pay_run_adjustment_id)
     AND NOT (OLD.status = 'queued' AND NEW.status = 'delivered') THEN
    RAISE EXCEPTION
      'HRM benefit award % delivery linkage writes only on the queued-to-delivered move — record delivery through the award service.', OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_award_snapshot_immutable_trigger ON public.hrm_benefit_awards;
CREATE TRIGGER hrm_benefit_award_snapshot_immutable_trigger
  BEFORE UPDATE ON public.hrm_benefit_awards
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_award_snapshot_immutable_guard();

-- Active program rules are effective-dated policy, never in-place edits:
-- once active or closed, only the lifecycle status, revision stamp, and audit
-- columns move. Drafts edit through the program service, which locks the row
-- and audits the change. Amend path honoured so a row can never pin its org.
CREATE OR REPLACE FUNCTION public.hrm_benefit_program_active_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('active', 'closed') AND (
    NEW.code IS DISTINCT FROM OLD.code
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.family IS DISTINCT FROM OLD.family
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
    OR NEW.pay_component_id IS DISTINCT FROM OLD.pay_component_id
    OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
    OR NEW.valuation IS DISTINCT FROM OLD.valuation
    OR NEW.metric IS DISTINCT FROM OLD.metric
    OR NEW.metric_scope IS DISTINCT FROM OLD.metric_scope
    OR NEW.allocation IS DISTINCT FROM OLD.allocation
    OR NEW.percent_rate IS DISTINCT FROM OLD.percent_rate
    OR NEW.fixed_amount IS DISTINCT FROM OLD.fixed_amount
    OR NEW.cap_amount IS DISTINCT FROM OLD.cap_amount
    OR NEW.budget_amount IS DISTINCT FROM OLD.budget_amount
    OR NEW.threshold_amount IS DISTINCT FROM OLD.threshold_amount
    OR NEW.frequency IS DISTINCT FROM OLD.frequency
    OR NEW.period_basis IS DISTINCT FROM OLD.period_basis
    OR NEW.payment_delay_days IS DISTINCT FROM OLD.payment_delay_days
    OR (NEW.status NOT IN ('active', 'closed'))
  ) THEN
    RAISE EXCEPTION
      'HRM benefit program % is % policy — close it and open a new revision instead of editing rules in place.', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_program_active_immutable_trigger ON public.hrm_benefit_programs;
CREATE TRIGGER hrm_benefit_program_active_immutable_trigger
  BEFORE UPDATE ON public.hrm_benefit_programs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_program_active_immutable_guard();

-- Awards and program configuration are retained history: void or close them,
-- never delete them. Amend path honoured so a row can never pin its org.
CREATE OR REPLACE FUNCTION public.hrm_benefit_program_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM benefit program % is retained as history — close it instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_program_no_delete_trigger ON public.hrm_benefit_programs;
CREATE TRIGGER hrm_benefit_program_no_delete_trigger
  BEFORE DELETE ON public.hrm_benefit_programs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_program_no_delete();

CREATE OR REPLACE FUNCTION public.hrm_benefit_award_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD.status = 'delivered' THEN
    RAISE EXCEPTION
      'HRM benefit award % is delivered history — issue an adjusting award instead of deleting it.', OLD.id;
  END IF;
  RAISE EXCEPTION
    'HRM benefit award % is retained as history — void it instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_award_no_delete_trigger ON public.hrm_benefit_awards;
CREATE TRIGGER hrm_benefit_award_no_delete_trigger
  BEFORE DELETE ON public.hrm_benefit_awards
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_award_no_delete();

CREATE OR REPLACE FUNCTION public.hrm_benefit_award_event_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'HRM benefit award event % is immutable evidence — record a new event instead of updating it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_award_event_immutable_trigger ON public.hrm_benefit_award_events;
CREATE TRIGGER hrm_benefit_award_event_immutable_trigger
  BEFORE UPDATE ON public.hrm_benefit_award_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_award_event_immutable_guard();

CREATE OR REPLACE FUNCTION public.hrm_benefit_award_event_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM benefit award event % is retained as audit evidence — it is never deleted.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_award_event_no_delete_trigger ON public.hrm_benefit_award_events;
CREATE TRIGGER hrm_benefit_award_event_no_delete_trigger
  BEFORE DELETE ON public.hrm_benefit_award_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_award_event_no_delete();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0184/0185 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all six tables. Benefit programs stay out of the
-- generic governed-query catalog like the 0197 benefit tables: no refresh
-- call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_benefit_programs', 'hrm_benefit_program_scopes',
    'hrm_benefit_program_sources',
    'hrm_benefit_program_members', 'hrm_benefit_awards',
    'hrm_benefit_award_events'] LOOP
    EXECUTE format('ALTER TABLE ONLY public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE ONLY public.%I FORCE ROW LEVEL SECURITY', tbl);
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = tbl
                      AND policyname = 'org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY org_isolation ON public.%I
           USING ((SELECT public.app_bypass_rls_active())
               OR ((org_id)::text = (SELECT current_setting(''app.current_org'', true))))
           WITH CHECK ((SELECT public.app_bypass_rls_active())
               OR ((org_id)::text = (SELECT current_setting(''app.current_org'', true))))',
        tbl);
    END IF;
    EXECUTE format(
      'COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''',
      tbl);
  END LOOP;
END $$;

COMMENT ON TABLE public.hrm_benefit_programs IS
  'HRM employer-defined benefit programs (0469): rewards, allowances, incentives, and custom programs with typed rule columns. Insured plans (hrm_benefit_plans) stay authoritative for health and retirement. Programs close rather than delete; history is preserved.';
COMMENT ON TABLE public.hrm_benefit_program_scopes IS
  'HRM benefit program measurement scope (0469): typed child table resolving departments and projects through tenant keys. Company scope carries no rows.';
COMMENT ON TABLE public.hrm_benefit_program_sources IS
  'HRM benefit program funding sources (0469): typed child table naming the source accounts per program. No overlapping hardcoded account policy.';
COMMENT ON TABLE public.hrm_benefit_program_members IS
  'HRM benefit program membership (0469): employments bound to a program over effective dates with weight and role for allocation.';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'pay_run_adjustments_org_id_id_unique') THEN
  ALTER TABLE ONLY public.pay_run_adjustments ADD CONSTRAINT pay_run_adjustments_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_awards_adjustment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_awards ADD CONSTRAINT hrm_benefit_awards_adjustment_tenant_fkey
    FOREIGN KEY (org_id, pay_run_adjustment_id) REFERENCES public.pay_run_adjustments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

COMMENT ON TABLE public.hrm_benefit_awards IS
  'HRM benefit awards (0469): each issuance with immutable program and source snapshots, evidence, lifecycle status, and payroll or external linkage. Corrections void and reissue; never rewrite.';
COMMENT ON TABLE public.hrm_benefit_award_events IS
  'HRM benefit award lifecycle evidence (0469): append-only. Every move appends an event with reason and actor.';
