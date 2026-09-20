-- OpenBooks forward migration 0197_hrm_benefits.
--
-- HR-8 benefits (HR records) and the amount-kind pay-run input seam. An
-- employment can be hired, moved and ended, but nothing records what the org
-- provides it beyond pay: plans the org offers, windows in which people
-- elect, elections with dependents, and the resulting monthly amounts. The
-- amounts cross into payroll ONLY as pay-run input rows. HR owns the
-- election; payroll owns the money movement.
--
-- Country-agnostic: plan kinds and tax treatment are org-declared
-- text/config, never a built-in list of one jurisdiction's programmes. An
-- amount alone cannot tell the run whether a deduction is pre-tax or
-- post-tax, so the treatment lives on the pay component
-- (pay_components.tax_treatment): every input row names its component and
-- the run prices it with no benefits-specific logic.
--
-- SEPARATE seam table (coordinator ruling, item 57): 0194's
-- hrm_payroll_inputs keeps its hours-only invariants untouched — widening it
-- would weaken what the leave consumer (engine/src/hrm/leave-payroll-inputs.ts,
-- unchanged by this migration) was built against. hrm_benefit_payroll_inputs
-- below carries AMOUNTS per coverage month; the run allocates coverage
-- months to pay periods on its side. HR never computes pay-period
-- boundaries; payroll never prorates or recomputes an amount from
-- coverage_from/to — the row carries the amount HR means, after HR-side
-- proration (plans.proration_basis) from the enrolment's effective dates.
-- Currency is stored from the plan and never converted; the run refuses a
-- mismatch.
--
-- Coverage levels are a CHILD TABLE (hrm_benefit_plan_levels), not a jsonb
-- column: workforce entities may not expose raw-JSON fields
-- (web/lib/setup/registry.test.ts), and the Setup pattern for an ordered
-- child collection is a second entity (0193 templates/steps precedent).
-- Levels are the single source of truth for tier pricing; no parallel jsonb.
--
-- Tables (all org-scoped, all under the org_isolation RLS below):
--   hrm_benefit_plans        the org's offered plans with cost bases,
--                            proration rule, and pay-component links.
--   hrm_benefit_plan_levels  ordered pricing tiers per plan (single source).
--   hrm_enrollment_windows   windows in which people elect, with the 0193
--                            applies_to shape CHECK and slot projections.
--   hrm_benefit_enrollments  elections: amounts computed at election and
--                            STORED, so a later plan price change never
--                            rewrites an existing election. Changes end the
--                            active row and open a new one — never in-place.
--   hrm_benefit_dependents + hrm_enrollment_dependents: covered persons.
--   hrm_benefit_events       append-only election evidence (refuse-update).
--   hrm_benefit_payroll_inputs: ONE ROW PER ENROLMENT PER COVERAGE MONTH
--                            PER KIND. employee_party_id is the key the run
--                            reads, resolved by HR from the employment at
--                            write time; employment_id is provenance only.
--                            unique (org_id, enrollment_id, kind,
--                            coverage_from) makes regeneration idempotent.
--
-- consumed_by_run_document_id is the ONLY link back to a stale run, so
-- voiding NEVER clears it: the void guard below refuses any update that
-- clears the link, exactly as 0194.
--
-- Deletes: elections, events, dependents and payroll inputs are retained
-- history. Plans, levels and windows retire through is_active / closed
-- status; their RESTRICT FKs refuse a delete that would orphan an election.
-- The governed amend path (openbooks.amend = on: fixture teardown, sandbox
-- wipe, org purge) is honoured so a benefits row can never pin its
-- organisation; production paths never set that GUC.
--
-- Additive only. Alters no payroll table (the pay_components unique below
-- only enrolls it in tenant FKs), performs no backfill, exposes nothing to
-- the generic governed-query catalog.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Tenant-FK enrollment for pay_components (additive): the (org_id, id)
-- unique every HRM tenant FK needs. Plans and input rows reference
-- pay_components through (org_id, pay_component_id) below.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pay_components_org_id_id_unique') THEN
  ALTER TABLE ONLY public.pay_components ADD CONSTRAINT pay_components_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_benefit_plans (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    -- Org-declared kind (health, dental, vision, life, disability,
    -- retirement, wellness, other, ...). Free text, never an enum: no pack
    -- declares plan kinds; this table is the single source of truth.
    kind text NOT NULL,
    provider_party_id uuid,
    -- Null = offered to every subsidiary. Proven at save: an unknown
    -- subsidiary is refused, a plan that can never apply is not saved.
    employer_subsidiary_id uuid,
    currency char(3) NOT NULL,
    employee_cost_basis text NOT NULL,
    employee_cost numeric(19,4),
    employer_cost_basis text NOT NULL,
    employer_cost numeric(19,4),
    -- Pay-component links (coordinator ruling): nullable ONLY for the side
    -- with no cost. Election refuses a plan whose needed component is
    -- missing; the employer component must be kind employer_contribution
    -- (validated on save AND on generation, so employer money can never
    -- reach net pay). Tax treatment lives on the component, never here.
    employee_pay_component_id uuid,
    employer_pay_component_id uuid,
    -- The org's own declaration (packs interpret). Never derived by HR.
    pretax boolean NOT NULL DEFAULT false,
    -- Partial-month proration rule, REQUIRED with no default: a silent
    -- default would guess what a partial month pays. full_month = the row
    -- carries the whole month whatever the effective dates; daily = scaled
    -- by covered days over days in month. Election refuses a plan without
    -- it; generation applies it from the enrolment's effective dates.
    proration_basis text NOT NULL,
    waiting_period_days integer NOT NULL DEFAULT 0,
    requires_approval boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_plans_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_plans_code CHECK (char_length(btrim(code)) > 0),
    CONSTRAINT hrm_benefit_plans_name CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_benefit_plans_kind CHECK (char_length(btrim(kind)) > 0),
    CONSTRAINT hrm_benefit_plans_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT hrm_benefit_plans_employee_basis
      CHECK (employee_cost_basis IN ('per_period', 'per_month', 'per_year', 'percent_of_pay')),
    CONSTRAINT hrm_benefit_plans_employer_basis
      CHECK (employer_cost_basis IN ('per_period', 'per_month', 'per_year', 'percent_of_pay')),
    CONSTRAINT hrm_benefit_plans_costs
      CHECK ((employee_cost IS NULL OR employee_cost >= 0)
         AND (employer_cost IS NULL OR employer_cost >= 0)),
    CONSTRAINT hrm_benefit_plans_proration
      CHECK (proration_basis IN ('full_month', 'daily')),
    CONSTRAINT hrm_benefit_plans_waiting CHECK (waiting_period_days >= 0),
    CONSTRAINT hrm_benefit_plans_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT hrm_benefit_plans_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    )
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plans_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_plans ADD CONSTRAINT hrm_benefit_plans_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plans_org_code_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_plans ADD CONSTRAINT hrm_benefit_plans_org_code_unique UNIQUE (org_id, code); END IF; END $$;

-- Ordered pricing tiers per plan: the single source of truth for tier
-- pricing (no parallel jsonb). An election names its tier by
-- coverage_level_key; the tier amounts are COPIED onto the election at
-- elect time, so retiring or repricing a tier never rewrites history.
CREATE TABLE IF NOT EXISTS public.hrm_benefit_plan_levels (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    level_key text NOT NULL,
    label text NOT NULL,
    employee_cost numeric(19,4) NOT NULL,
    employer_cost numeric(19,4) NOT NULL,
    position integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_plan_levels_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_plan_levels_key CHECK (char_length(btrim(level_key)) > 0),
    CONSTRAINT hrm_benefit_plan_levels_label CHECK (char_length(btrim(label)) > 0),
    CONSTRAINT hrm_benefit_plan_levels_costs
      CHECK (employee_cost >= 0 AND employer_cost >= 0),
    CONSTRAINT hrm_benefit_plan_levels_position CHECK (position >= 0)
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plan_levels_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_plan_levels ADD CONSTRAINT hrm_benefit_plan_levels_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plan_levels_org_plan_key_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_plan_levels ADD CONSTRAINT hrm_benefit_plan_levels_org_plan_key_unique UNIQUE (org_id, plan_id, level_key); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plan_levels_org_plan_position_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_plan_levels ADD CONSTRAINT hrm_benefit_plan_levels_org_plan_position_unique UNIQUE (org_id, plan_id, position); END IF; END $$;

CREATE TABLE IF NOT EXISTS public.hrm_enrollment_windows (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    opens_on date NOT NULL,
    closes_on date NOT NULL,
    plan_year_start_on date NOT NULL,
    -- Scoping: {"employer_subsidiary_id": uuid|null, "department_id": uuid|null}.
    -- Null pins mean org-wide. Overlaps are refused service-side by kind and
    -- scope; storage carries the declaration, never the resolution.
    applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'draft',
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_enrollment_windows_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_enrollment_windows_name CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_enrollment_windows_kind
      CHECK (kind IN ('open_enrollment', 'new_hire', 'life_event')),
    CONSTRAINT hrm_enrollment_windows_dates CHECK (closes_on >= opens_on),
    CONSTRAINT hrm_enrollment_windows_status CHECK (status IN ('draft', 'open', 'closed')),
    CONSTRAINT hrm_enrollment_windows_applies_shape
      CHECK (jsonb_typeof(applies_to) = 'object'
        AND (applies_to - 'employer_subsidiary_id' - 'department_id') = '{}'::jsonb
        AND (NOT (applies_to ? 'employer_subsidiary_id')
             OR jsonb_typeof(applies_to -> 'employer_subsidiary_id') = 'null'
             OR (jsonb_typeof(applies_to -> 'employer_subsidiary_id') = 'string'
                 AND applies_to ->> 'employer_subsidiary_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
        AND (NOT (applies_to ? 'department_id')
             OR jsonb_typeof(applies_to -> 'department_id') = 'null'
             OR (jsonb_typeof(applies_to -> 'department_id') = 'string'
                 AND applies_to ->> 'department_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))),
    CONSTRAINT hrm_enrollment_windows_finite_time CHECK (
      opens_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND closes_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND plan_year_start_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    )
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_enrollment_windows_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_enrollment_windows ADD CONSTRAINT hrm_enrollment_windows_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- Read-only slot projections of the window scope for structured surfaces
-- (0193 pattern: the Setup drawer prefills ref selects from row columns,
-- and a raw-JSON workforce field is barred by registry.test.ts): GENERATED
-- ALWAYS STORED, readable but never written — the Setup write path folds
-- the slots back into applies_to before buildRow, and the shape CHECK above
-- stays the single authority on the filter's content.
ALTER TABLE ONLY public.hrm_enrollment_windows
  ADD COLUMN IF NOT EXISTS applies_employer_subsidiary_id uuid
    GENERATED ALWAYS AS ((applies_to ->> 'employer_subsidiary_id')::uuid) STORED;
ALTER TABLE ONLY public.hrm_enrollment_windows
  ADD COLUMN IF NOT EXISTS applies_department_id uuid
    GENERATED ALWAYS AS ((applies_to ->> 'department_id')::uuid) STORED;

CREATE TABLE IF NOT EXISTS public.hrm_benefit_enrollments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    window_id uuid,
    -- Tier key into hrm_benefit_plan_levels (org, plan, key). Null = the
    -- plan's base costs. Validated at elect time; the amounts below are
    -- copied from the plan/tier then and never re-resolved.
    coverage_level_key text,
    status text NOT NULL DEFAULT 'elected',
    effective_from date NOT NULL,
    effective_to date,
    -- Stored per-period election amounts in plan currency: a later plan
    -- price change never rewrites these. Null side = waived / no cost on
    -- that side (a waived election carries neither amount).
    employee_amount_per_period numeric(19,4),
    employer_amount_per_period numeric(19,4),
    currency char(3) NOT NULL,
    elected_at timestamp with time zone DEFAULT now() NOT NULL,
    elected_by uuid,
    ended_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_enrollments_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_enrollments_status
      CHECK (status IN ('elected', 'waived', 'pending_approval', 'active', 'ended', 'cancelled')),
    CONSTRAINT hrm_benefit_enrollments_window
      CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT hrm_benefit_enrollments_amounts
      CHECK ((employee_amount_per_period IS NULL OR employee_amount_per_period >= 0)
         AND (employer_amount_per_period IS NULL OR employer_amount_per_period >= 0)),
    CONSTRAINT hrm_benefit_enrollments_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT hrm_benefit_enrollments_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    )
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_enrollments_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_enrollments ADD CONSTRAINT hrm_benefit_enrollments_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_enrollments_employment_plan_from_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_enrollments ADD CONSTRAINT hrm_benefit_enrollments_employment_plan_from_unique
    UNIQUE (org_id, employment_id, plan_id, effective_from); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_enrollments_employment ON public.hrm_benefit_enrollments (org_id, employment_id);
CREATE INDEX IF NOT EXISTS hrm_benefit_enrollments_plan ON public.hrm_benefit_enrollments (org_id, plan_id);
CREATE INDEX IF NOT EXISTS hrm_benefit_enrollments_status ON public.hrm_benefit_enrollments (org_id, status);

-- Covered persons. display_name is PII: enrolled in sandbox masking like
-- parties (see the masking registration this migration's commit carries).
CREATE TABLE IF NOT EXISTS public.hrm_benefit_dependents (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    relationship text NOT NULL,
    display_name text NOT NULL,
    birth_date date,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_dependents_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_dependents_relationship
      CHECK (relationship IN ('spouse', 'partner', 'child', 'other')),
    CONSTRAINT hrm_benefit_dependents_name CHECK (char_length(btrim(display_name)) > 0)
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_dependents_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_dependents ADD CONSTRAINT hrm_benefit_dependents_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_dependents_employment ON public.hrm_benefit_dependents (org_id, employment_id);

CREATE TABLE IF NOT EXISTS public.hrm_enrollment_dependents (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    dependent_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT hrm_enrollment_dependents_pkey PRIMARY KEY (id)
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_enrollment_dependents_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_enrollment_dependents ADD CONSTRAINT hrm_enrollment_dependents_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_enrollment_dependents_org_link_unique') THEN
  ALTER TABLE ONLY public.hrm_enrollment_dependents ADD CONSTRAINT hrm_enrollment_dependents_org_link_unique
    UNIQUE (org_id, enrollment_id, dependent_id); END IF; END $$;

-- Append-only election evidence: every lifecycle move appends an event with
-- its reason and actor. Updates and deletes are refused (amend path
-- excepted); a correction is a new event, never a rewrite.
CREATE TABLE IF NOT EXISTS public.hrm_benefit_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    kind text NOT NULL,
    reason text NOT NULL,
    actor uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT hrm_benefit_events_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_events_kind
      CHECK (kind IN ('elected', 'waived', 'approved', 'activated', 'changed', 'ended', 'cancelled', 'life_event')),
    CONSTRAINT hrm_benefit_events_reason CHECK (char_length(btrim(reason)) > 0)
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_events_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_events ADD CONSTRAINT hrm_benefit_events_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_events_enrollment ON public.hrm_benefit_events (org_id, enrollment_id);

-- The amount-kind pay-run input seam (see file header): ONE ROW PER
-- ENROLMENT PER COVERAGE MONTH PER KIND. amount is the row's whole meaning
-- for coverage_from..coverage_to after HR-side proration — payroll
-- allocates it to pay periods and never recomputes it. employee_party_id is
-- the key the run reads; employment_id is provenance only and the two are
-- NEVER interchangeable. pay_component_id names the component whose
-- tax_treatment prices the row; the run refuses a currency mismatch.
-- unique (org_id, enrollment_id, kind, coverage_from) makes regeneration
-- idempotent: a retried month lands on the same rows.
CREATE TABLE IF NOT EXISTS public.hrm_benefit_payroll_inputs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    kind text NOT NULL,
    pay_component_id uuid NOT NULL,
    amount numeric(19,4) NOT NULL,
    currency char(3) NOT NULL,
    coverage_from date NOT NULL,
    coverage_to date NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    consumed_by_run_document_id uuid,
    consumed_at timestamp with time zone,
    voided_at timestamp with time zone,
    void_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_benefit_payroll_inputs_pkey PRIMARY KEY (id),
    CONSTRAINT hrm_benefit_payroll_inputs_kind
      CHECK (kind IN ('benefit_deduction', 'employer_contribution')),
    CONSTRAINT hrm_benefit_payroll_inputs_amount CHECK (amount > 0),
    CONSTRAINT hrm_benefit_payroll_inputs_currency CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT hrm_benefit_payroll_inputs_coverage CHECK (coverage_to >= coverage_from),
    CONSTRAINT hrm_benefit_payroll_inputs_status CHECK (status IN ('pending', 'consumed', 'voided')),
    CONSTRAINT hrm_benefit_payroll_inputs_finite_time CHECK (
      coverage_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND coverage_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    ),
    -- Consumed rows name their run; pending rows name none. Voided rows KEEP
    -- whatever run they named (the only link back to the stale run) — the
    -- guard below refuses any update that clears it.
    CONSTRAINT hrm_benefit_payroll_inputs_consumed_link CHECK (
      (status = 'consumed' AND consumed_by_run_document_id IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status = 'pending' AND consumed_by_run_document_id IS NULL AND consumed_at IS NULL)
      OR (status = 'voided')
    )
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_payroll_inputs_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_payroll_inputs ADD CONSTRAINT hrm_benefit_payroll_inputs_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_payroll_inputs_enrollment_kind_month_unique') THEN
  ALTER TABLE ONLY public.hrm_benefit_payroll_inputs ADD CONSTRAINT hrm_benefit_payroll_inputs_enrollment_kind_month_unique
    UNIQUE (org_id, enrollment_id, kind, coverage_from); END IF; END $$;
CREATE INDEX IF NOT EXISTS hrm_benefit_payroll_inputs_party_month ON public.hrm_benefit_payroll_inputs (org_id, employee_party_id, coverage_from);
CREATE INDEX IF NOT EXISTS hrm_benefit_payroll_inputs_run ON public.hrm_benefit_payroll_inputs (org_id, consumed_by_run_document_id) WHERE consumed_by_run_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hrm_benefit_payroll_inputs_status ON public.hrm_benefit_payroll_inputs (org_id, status);

-- ---------------------------------------------------------------------------
-- Tenant-coherent foreign keys (all deferrable, so a whole-org teardown
-- transaction completes; 0188 precedent).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plans_provider_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_plans ADD CONSTRAINT hrm_benefit_plans_provider_tenant_fkey
    FOREIGN KEY (org_id, provider_party_id) REFERENCES public.parties (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plans_subsidiary_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_plans ADD CONSTRAINT hrm_benefit_plans_subsidiary_tenant_fkey
    FOREIGN KEY (org_id, employer_subsidiary_id) REFERENCES public.subsidiaries (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plans_employee_component_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_plans ADD CONSTRAINT hrm_benefit_plans_employee_component_tenant_fkey
    FOREIGN KEY (org_id, employee_pay_component_id) REFERENCES public.pay_components (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plans_employer_component_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_plans ADD CONSTRAINT hrm_benefit_plans_employer_component_tenant_fkey
    FOREIGN KEY (org_id, employer_pay_component_id) REFERENCES public.pay_components (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_plan_levels_plan_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_plan_levels ADD CONSTRAINT hrm_benefit_plan_levels_plan_tenant_fkey
    FOREIGN KEY (org_id, plan_id) REFERENCES public.hrm_benefit_plans (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_enrollments_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_enrollments ADD CONSTRAINT hrm_benefit_enrollments_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_enrollments_plan_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_enrollments ADD CONSTRAINT hrm_benefit_enrollments_plan_tenant_fkey
    FOREIGN KEY (org_id, plan_id) REFERENCES public.hrm_benefit_plans (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_enrollments_window_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_enrollments ADD CONSTRAINT hrm_benefit_enrollments_window_tenant_fkey
    FOREIGN KEY (org_id, window_id) REFERENCES public.hrm_enrollment_windows (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_dependents_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_dependents ADD CONSTRAINT hrm_benefit_dependents_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_enrollment_dependents_enrollment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_enrollment_dependents ADD CONSTRAINT hrm_enrollment_dependents_enrollment_tenant_fkey
    FOREIGN KEY (org_id, enrollment_id) REFERENCES public.hrm_benefit_enrollments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_enrollment_dependents_dependent_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_enrollment_dependents ADD CONSTRAINT hrm_enrollment_dependents_dependent_tenant_fkey
    FOREIGN KEY (org_id, dependent_id) REFERENCES public.hrm_benefit_dependents (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_events_enrollment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_events ADD CONSTRAINT hrm_benefit_events_enrollment_tenant_fkey
    FOREIGN KEY (org_id, enrollment_id) REFERENCES public.hrm_benefit_enrollments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_payroll_inputs_enrollment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_payroll_inputs ADD CONSTRAINT hrm_benefit_payroll_inputs_enrollment_tenant_fkey
    FOREIGN KEY (org_id, enrollment_id) REFERENCES public.hrm_benefit_enrollments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_payroll_inputs_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_payroll_inputs ADD CONSTRAINT hrm_benefit_payroll_inputs_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
-- employee_party_id is the key the run reads, resolved by HR from the
-- employment at write time. The tenant FK keeps it coherent and enrolls the
-- column in the audited party-merge path (SIMPLE: re-pointing the party
-- cannot collide — the uniqueness here is (org, enrollment, kind, month),
-- which carries no party column).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_payroll_inputs_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_payroll_inputs ADD CONSTRAINT hrm_benefit_payroll_inputs_party_tenant_fkey
    FOREIGN KEY (org_id, employee_party_id) REFERENCES public.parties (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;
-- pay_component_id names the component whose tax_treatment prices the row.
-- SIMPLE in the merge path for the same reason: no party column in the
-- uniqueness, so a component is never re-pointed by a party merge.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_payroll_inputs_component_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_payroll_inputs ADD CONSTRAINT hrm_benefit_payroll_inputs_component_tenant_fkey
    FOREIGN KEY (org_id, pay_component_id) REFERENCES public.pay_components (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

-- Benefit events are immutable evidence: a correction is a new event, never
-- an update. Deletes are admitted only on the governed amend path.
CREATE OR REPLACE FUNCTION public.hrm_benefit_event_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'HRM benefit event % is immutable evidence — record a new event instead of updating it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_event_immutable_trigger ON public.hrm_benefit_events;
CREATE TRIGGER hrm_benefit_event_immutable_trigger
  BEFORE UPDATE ON public.hrm_benefit_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_event_immutable_guard();

CREATE OR REPLACE FUNCTION public.hrm_benefit_event_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM benefit event % is retained as audit evidence — it is never deleted.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_event_no_delete_trigger ON public.hrm_benefit_events;
CREATE TRIGGER hrm_benefit_event_no_delete_trigger
  BEFORE DELETE ON public.hrm_benefit_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_event_no_delete();

-- Elections are retained history: end or cancel them, never delete them.
-- Amend path honoured so an election can never pin its organisation.
CREATE OR REPLACE FUNCTION public.hrm_benefit_enrollment_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM benefit enrollment % is retained as history — end or cancel it instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_enrollment_no_delete_trigger ON public.hrm_benefit_enrollments;
CREATE TRIGGER hrm_benefit_enrollment_no_delete_trigger
  BEFORE DELETE ON public.hrm_benefit_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_enrollment_no_delete();

-- Voiding NEVER clears consumed_by_run_document_id: it is the only link
-- back to the stale run. A void that clears the link would make a stale
-- calculation invisible. Voided rows carry voided_at and a reason.
CREATE OR REPLACE FUNCTION public.hrm_benefit_payroll_input_void_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.status = 'voided' AND OLD.consumed_by_run_document_id IS NOT NULL
     AND NEW.consumed_by_run_document_id IS DISTINCT FROM OLD.consumed_by_run_document_id THEN
    RAISE EXCEPTION
      'HRM benefit payroll input % was consumed by pay run % — voiding keeps that link so the stale run stays visible; recalculate the run instead of unlinking it.',
      OLD.id, OLD.consumed_by_run_document_id;
  END IF;
  IF NEW.status = 'pending' AND OLD.status = 'voided' THEN
    RAISE EXCEPTION
      'HRM benefit payroll input % is voided and stays voided — regenerate the month for a revised amount.',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_payroll_input_void_guard_trigger ON public.hrm_benefit_payroll_inputs;
CREATE TRIGGER hrm_benefit_payroll_input_void_guard_trigger
  BEFORE UPDATE ON public.hrm_benefit_payroll_inputs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_payroll_input_void_guard();

CREATE OR REPLACE FUNCTION public.hrm_benefit_payroll_input_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM benefit payroll input % is retained as history — void it instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_benefit_payroll_input_no_delete_trigger ON public.hrm_benefit_payroll_inputs;
CREATE TRIGGER hrm_benefit_payroll_input_no_delete_trigger
  BEFORE DELETE ON public.hrm_benefit_payroll_inputs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_payroll_input_no_delete();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0184/0185 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all eight tables. Benefits stay out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_benefit_plans', 'hrm_benefit_plan_levels',
    'hrm_enrollment_windows', 'hrm_benefit_enrollments',
    'hrm_benefit_dependents', 'hrm_enrollment_dependents',
    'hrm_benefit_events', 'hrm_benefit_payroll_inputs'] LOOP
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

COMMENT ON TABLE public.hrm_benefit_plans IS
  'HRM benefit plans (0197): the org''s offered plans with cost bases, the required proration rule, and pay-component links. Tax treatment lives on the pay component, never here. Plan kind is org-declared free text; no pack declares plan kinds.';
COMMENT ON COLUMN public.hrm_benefit_plans.proration_basis IS
  'Required partial-month rule with no default: full_month carries the whole month whatever the effective dates; daily scales by covered days over days in month. Payroll never prorates — the input row carries the amount this rule produced.';
COMMENT ON TABLE public.hrm_benefit_plan_levels IS
  'HRM benefit pricing tiers (0197): one row per tier per plan, the single source of truth for tier pricing. Elections copy tier amounts at elect time; repricing a tier never rewrites history.';
COMMENT ON TABLE public.hrm_enrollment_windows IS
  'HRM enrollment windows (0197): open_enrollment, new_hire, or life_event, with applies_to scoping and draft/open/closed lifecycle. Closing refuses pending elections with a reasoned event each — never silently dropped.';
COMMENT ON TABLE public.hrm_benefit_enrollments IS
  'HRM benefit elections (0197): amounts computed from the plan basis at election and STORED in plan currency. A change ends the active row and opens a new one from the change date — never an in-place rewrite. unique (org_id, employment_id, plan_id, effective_from).';
COMMENT ON TABLE public.hrm_benefit_dependents IS
  'HRM covered dependents (0197). display_name is PII and enrolled in sandbox masking like parties.';
COMMENT ON TABLE public.hrm_benefit_events IS
  'HRM benefit election evidence (0197): append-only. Every lifecycle move appends an event with reason and actor; corrections are new events, never updates.';
COMMENT ON TABLE public.hrm_benefit_payroll_inputs IS
  'HRM benefit pay-run input seam (0197): ONE ROW PER ENROLMENT PER COVERAGE MONTH PER KIND. HR sends AMOUNTS (already prorated by the plan rule) — payroll allocates months to pay periods and never recomputes. pay_component_id names the component whose tax_treatment prices the row; employee_party_id is the key the run reads; employment_id is provenance only. unique (org_id, enrollment_id, kind, coverage_from). Voiding never clears consumed_by_run_document_id.';
COMMENT ON COLUMN public.hrm_benefit_payroll_inputs.amount IS
  'The row''s whole meaning for coverage_from..coverage_to in currency: the monthly amount after HR-side proration. Payroll allocates it to pay periods; it never prorates or recomputes it from the coverage dates.';
