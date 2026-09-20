-- OpenBooks forward migration 0223_hrm_construction_rates.
--
-- HR-13 construction compliance (rate tables, classifications, per-diem).
-- The target customers self-perform construction: the product must resolve
-- a wage by project location x classification x date, split workers' comp
-- by cost code, enforce apprentice ratios daily, and compute per-diem from
-- the timesheet. The generic layer is COUNTRY-AGNOSTIC: every form, rate
-- source, class list and rule here is an org-declared table or pack
-- vocabulary carried as free text. The generic layer branches on nothing —
-- jurisdiction_code is free text at this layer; packs interpret it.
--
-- Tables (all org-scoped, all under the org_isolation RLS below):
--   hrm_work_classifications    trade/classification taxonomy with the
--                               apprentice flag and the journey class an
--                               apprentice ratio counts against.
--   hrm_rate_schedules          prevailing-wage / union-agreement /
--                               org-declared rate schedules with 0193-shaped
--                               applies_to scoping plus project_ids and
--                               location_ids arrays, and the org-declared
--                               reciprocity the resolver applies.
--   hrm_rate_schedule_lines     one rate line per schedule per
--                               classification per effective date.
--   hrm_employment_classifications
--                               bitemporal assignment of an employment to a
--                               classification, with the worker's home local.
--   hrm_per_diem_policies       per-diem computation policies; rules are
--                               validated by a zod schema per basis in the
--                               service, shape-pinned here as an object.
--   hrm_per_diem_entries        computed per-diem rows, one per employment
--                               per project per day; voids keep their reason.
--   hrm_travel_pay_entries      same shape as per-diem, separate table so
--                               voids never cross between the two kinds.
--   hrm_allowance_payroll_inputs
--                               the THIRD HR->payroll seam (coordinator
--                               ruling pattern from 0197): per-diem and
--                               travel rows cross to payroll as AMOUNTS keyed
--                               by entry, never recomputed by the run.
--                               hrm_benefit_payroll_inputs is NOT reused —
--                               it is enrollment-keyed and widening it would
--                               weaken what the benefits consumer was built
--                               against.
--
-- Additive only. No backfill, no payroll table altered (the pay_components
-- unique below only enrolls it in tenant FKs; 0197 already enrolled it —
-- the IF NOT EXISTS keeps this re-runnable), nothing exposed to the
-- generic governed-query catalog.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pay_components_org_id_id_unique') THEN
  ALTER TABLE ONLY public.pay_components ADD CONSTRAINT pay_components_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (1) Work classifications: the org's trade taxonomy.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_work_classifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  trade text NOT NULL,
  is_apprentice boolean NOT NULL DEFAULT false,
  apprentice_program_ref text,
  journey_classification_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_work_classifications_code
    CHECK (char_length(btrim(code)) > 0),
  CONSTRAINT hrm_work_classifications_name
    CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT hrm_work_classifications_trade
    CHECK (char_length(btrim(trade)) > 0),
  CONSTRAINT hrm_work_classifications_journey_not_self
    CHECK (journey_classification_id IS NULL OR journey_classification_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_work_classifications_org_id_id_unique
  ON public.hrm_work_classifications (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_work_classifications_org_code_unique
  ON public.hrm_work_classifications (org_id, code);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_work_classifications_journey_fkey') THEN
  ALTER TABLE ONLY public.hrm_work_classifications
    ADD CONSTRAINT hrm_work_classifications_journey_fkey
    FOREIGN KEY (org_id, journey_classification_id) REFERENCES public.hrm_work_classifications (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (2) Rate schedules: prevailing-wage, union-agreement, org-declared.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_rate_schedules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  source_ref text,
  jurisdiction_code text,
  applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  reciprocity text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_rate_schedules_kind
    CHECK (kind IN ('prevailing_wage', 'union_agreement', 'org_declared')),
  CONSTRAINT hrm_rate_schedules_name
    CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT hrm_rate_schedules_reciprocity
    CHECK (reciprocity IN ('home_local', 'jobsite_local', 'higher_of')),
  CONSTRAINT hrm_rate_schedules_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT hrm_rate_schedules_applies_shape
    CHECK (jsonb_typeof(applies_to) = 'object'
      AND (applies_to - 'employer_subsidiary_id' - 'department_id' - 'project_ids' - 'location_ids') = '{}'::jsonb)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_rate_schedules_org_id_id_unique
  ON public.hrm_rate_schedules (org_id, id);
CREATE INDEX IF NOT EXISTS hrm_rate_schedules_org_active
  ON public.hrm_rate_schedules (org_id, is_active);

-- ---------------------------------------------------------------------------
-- (3) Rate schedule lines: the resolvable rate per classification per date.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_rate_schedule_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  classification_id uuid NOT NULL,
  base_rate numeric(19,4) NOT NULL,
  fringe_rate numeric(19,4) NOT NULL DEFAULT 0,
  fringe_credit_rate numeric(19,4) NOT NULL DEFAULT 0,
  overtime_multiplier numeric(19,4) NOT NULL DEFAULT 1.5,
  currency char(3) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_rate_schedule_lines_rates
    CHECK (base_rate >= 0 AND fringe_rate >= 0 AND fringe_credit_rate >= 0 AND overtime_multiplier >= 0),
  CONSTRAINT hrm_rate_schedule_lines_currency
    CHECK (char_length(btrim(currency)) = 3),
  CONSTRAINT hrm_rate_schedule_lines_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_rate_schedule_lines_org_id_id_unique
  ON public.hrm_rate_schedule_lines (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_rate_schedule_lines_version_unique
  ON public.hrm_rate_schedule_lines (schedule_id, classification_id, effective_from);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_rate_schedule_lines_schedule_fkey') THEN
  ALTER TABLE ONLY public.hrm_rate_schedule_lines
    ADD CONSTRAINT hrm_rate_schedule_lines_schedule_fkey
    FOREIGN KEY (org_id, schedule_id) REFERENCES public.hrm_rate_schedules (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_rate_schedule_lines_classification_fkey') THEN
  ALTER TABLE ONLY public.hrm_rate_schedule_lines
    ADD CONSTRAINT hrm_rate_schedule_lines_classification_fkey
    FOREIGN KEY (org_id, classification_id) REFERENCES public.hrm_work_classifications (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (4) Employment classifications: bitemporal assignment with history.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_employment_classifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  classification_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  home_schedule_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_employment_classifications_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_employment_classifications_org_id_id_unique
  ON public.hrm_employment_classifications (org_id, id);
CREATE INDEX IF NOT EXISTS hrm_employment_classifications_employment_asof
  ON public.hrm_employment_classifications (org_id, employment_id, effective_from);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_classifications_employment_fkey') THEN
  ALTER TABLE ONLY public.hrm_employment_classifications
    ADD CONSTRAINT hrm_employment_classifications_employment_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_classifications_classification_fkey') THEN
  ALTER TABLE ONLY public.hrm_employment_classifications
    ADD CONSTRAINT hrm_employment_classifications_classification_fkey
    FOREIGN KEY (org_id, classification_id) REFERENCES public.hrm_work_classifications (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_classifications_home_schedule_fkey') THEN
  ALTER TABLE ONLY public.hrm_employment_classifications
    ADD CONSTRAINT hrm_employment_classifications_home_schedule_fkey
    FOREIGN KEY (org_id, home_schedule_id) REFERENCES public.hrm_rate_schedules (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (5) Per-diem policies: org-declared computation rules per basis.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_per_diem_policies (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  basis text NOT NULL,
  rules jsonb NOT NULL,
  lodging_offset numeric(19,4),
  weekly_rule jsonb,
  -- No taxable flag: taxability is declared ONCE, on the linked pay
  -- component's tax_treatment (orchestrator ruling) — the policy names
  -- the component, generation refuses a non-earning component by name,
  -- and the drawer shows the component's treatment read-only.
  pay_component_id uuid,
  currency char(3) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_per_diem_policies_basis
    CHECK (basis IN ('flat_daily', 'distance_brackets', 'hours_threshold')),
  CONSTRAINT hrm_per_diem_policies_name
    CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT hrm_per_diem_policies_currency
    CHECK (char_length(btrim(currency)) = 3),
  CONSTRAINT hrm_per_diem_policies_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT hrm_per_diem_policies_rules_shape
    CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT hrm_per_diem_policies_weekly_shape
    CHECK (weekly_rule IS NULL OR jsonb_typeof(weekly_rule) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_per_diem_policies_org_id_id_unique
  ON public.hrm_per_diem_policies (org_id, id);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_per_diem_policies_component_fkey') THEN
  ALTER TABLE ONLY public.hrm_per_diem_policies
    ADD CONSTRAINT hrm_per_diem_policies_component_fkey
    FOREIGN KEY (org_id, pay_component_id) REFERENCES public.pay_components (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (6) Per-diem and travel-pay entries: one row per employment per project
-- per day. Separate tables so voids never cross between the two kinds.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_per_diem_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  project_id uuid,
  worked_on date NOT NULL,
  policy_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  currency char(3) NOT NULL,
  basis_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'computed',
  consumed_by_run_document_id uuid,
  voided_at timestamp with time zone,
  void_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_per_diem_entries_status
    CHECK (status IN ('computed', 'approved', 'voided', 'consumed')),
  CONSTRAINT hrm_per_diem_entries_amount
    CHECK (amount >= 0),
  CONSTRAINT hrm_per_diem_entries_void_reason
    CHECK ((status = 'voided' AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) > 0)
        OR (status <> 'voided'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_per_diem_entries_org_id_id_unique
  ON public.hrm_per_diem_entries (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_per_diem_entries_day_unique
  ON public.hrm_per_diem_entries (org_id, employment_id, project_id, worked_on) NULLS NOT DISTINCT;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_per_diem_entries_employment_fkey') THEN
  ALTER TABLE ONLY public.hrm_per_diem_entries
    ADD CONSTRAINT hrm_per_diem_entries_employment_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_per_diem_entries_policy_fkey') THEN
  ALTER TABLE ONLY public.hrm_per_diem_entries
    ADD CONSTRAINT hrm_per_diem_entries_policy_fkey
    FOREIGN KEY (org_id, policy_id) REFERENCES public.hrm_per_diem_policies (org_id, id); END IF; END $$;

CREATE TABLE IF NOT EXISTS public.hrm_travel_pay_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  project_id uuid,
  worked_on date NOT NULL,
  policy_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  currency char(3) NOT NULL,
  basis_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'computed',
  consumed_by_run_document_id uuid,
  voided_at timestamp with time zone,
  void_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_travel_pay_entries_status
    CHECK (status IN ('computed', 'approved', 'voided', 'consumed')),
  CONSTRAINT hrm_travel_pay_entries_amount
    CHECK (amount >= 0),
  CONSTRAINT hrm_travel_pay_entries_void_reason
    CHECK ((status = 'voided' AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) > 0)
        OR (status <> 'voided'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_travel_pay_entries_org_id_id_unique
  ON public.hrm_travel_pay_entries (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_travel_pay_entries_day_unique
  ON public.hrm_travel_pay_entries (org_id, employment_id, project_id, worked_on) NULLS NOT DISTINCT;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_travel_pay_entries_employment_fkey') THEN
  ALTER TABLE ONLY public.hrm_travel_pay_entries
    ADD CONSTRAINT hrm_travel_pay_entries_employment_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_travel_pay_entries_policy_fkey') THEN
  ALTER TABLE ONLY public.hrm_travel_pay_entries
    ADD CONSTRAINT hrm_travel_pay_entries_policy_fkey
    FOREIGN KEY (org_id, policy_id) REFERENCES public.hrm_per_diem_policies (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (7) Allowance payroll-input seam: per-diem and travel AMOUNTS for the run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_allowance_payroll_inputs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  entry_kind text NOT NULL,
  entry_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  employee_party_id uuid NOT NULL,
  pay_component_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  currency char(3) NOT NULL,
  coverage_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  consumed_by_run_document_id uuid,
  voided_at timestamp with time zone,
  void_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_allowance_payroll_inputs_kind
    CHECK (entry_kind IN ('per_diem', 'travel')),
  CONSTRAINT hrm_allowance_payroll_inputs_status
    CHECK (status IN ('pending', 'consumed', 'voided')),
  CONSTRAINT hrm_allowance_payroll_inputs_amount
    CHECK (amount > 0),
  CONSTRAINT hrm_allowance_payroll_inputs_currency
    CHECK (char_length(btrim(currency)) = 3),
  -- Status pairing (0197 doctrine): consumed names the run that took the
  -- row; voided carries when and why; pending carries neither. A void
  -- after consume keeps consumed_by_run_document_id — never cleared — so
  -- voided rows may still name their run. The component's kind
  -- (allowance/reimbursement) and tax_treatment are validated at
  -- generation and priced from the component by the run, never stored
  -- here — a parallel source of truth the product forbids.
  CONSTRAINT hrm_allowance_payroll_inputs_status_pairing
    CHECK ((status = 'consumed' AND consumed_by_run_document_id IS NOT NULL)
        OR (status = 'voided' AND voided_at IS NOT NULL
            AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) > 0)
        OR (status = 'pending' AND consumed_by_run_document_id IS NULL
            AND voided_at IS NULL AND void_reason IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_allowance_payroll_inputs_org_id_id_unique
  ON public.hrm_allowance_payroll_inputs (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_allowance_payroll_inputs_entry_unique
  ON public.hrm_allowance_payroll_inputs (org_id, entry_kind, entry_id);
-- The run's read path: one employee's days in status order.
CREATE INDEX IF NOT EXISTS hrm_allowance_payroll_inputs_run_read
  ON public.hrm_allowance_payroll_inputs (org_id, employee_party_id, coverage_date, status);
-- Stale-run visibility: everything a run consumed.
CREATE INDEX IF NOT EXISTS hrm_allowance_payroll_inputs_consumed_run
  ON public.hrm_allowance_payroll_inputs (consumed_by_run_document_id);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_allowance_payroll_inputs_employment_fkey') THEN
  ALTER TABLE ONLY public.hrm_allowance_payroll_inputs
    ADD CONSTRAINT hrm_allowance_payroll_inputs_employment_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_allowance_payroll_inputs_component_fkey') THEN
  ALTER TABLE ONLY public.hrm_allowance_payroll_inputs
    ADD CONSTRAINT hrm_allowance_payroll_inputs_component_fkey
    FOREIGN KEY (org_id, pay_component_id) REFERENCES public.pay_components (org_id, id); END IF; END $$;

-- employee_party_id is the key the run reads, resolved by HR from the
-- employment at write time. The tenant FK keeps it coherent and enrolls
-- the column in the audited party-merge path (SIMPLE: re-pointing the
-- party cannot collide — the uniqueness here is (org, entry_kind,
-- entry_id), which carries no party column).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_allowance_payroll_inputs_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_allowance_payroll_inputs
    ADD CONSTRAINT hrm_allowance_payroll_inputs_party_tenant_fkey
    FOREIGN KEY (org_id, employee_party_id) REFERENCES public.parties (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- Voiding NEVER clears consumed_by_run_document_id (0194/0197 doctrine):
-- it is the only link back to the stale run.
CREATE OR REPLACE FUNCTION public.hrm_allowance_payroll_input_void_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.status = 'voided' AND OLD.consumed_by_run_document_id IS NOT NULL
     AND NEW.consumed_by_run_document_id IS DISTINCT FROM OLD.consumed_by_run_document_id THEN
    RAISE EXCEPTION
      'HRM allowance payroll input % was consumed by pay run % — voiding keeps that link so the stale run stays visible; recalculate the run instead of unlinking it.',
      OLD.id, OLD.consumed_by_run_document_id;
  END IF;
  IF NEW.status = 'pending' AND OLD.status = 'voided' THEN
    RAISE EXCEPTION
      'HRM allowance payroll input % is voided and stays voided — regenerate the day for a revised amount.',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_allowance_payroll_input_void_guard_trigger ON public.hrm_allowance_payroll_inputs;
CREATE TRIGGER hrm_allowance_payroll_input_void_guard_trigger
  BEFORE UPDATE ON public.hrm_allowance_payroll_inputs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_allowance_payroll_input_void_guard();

CREATE OR REPLACE FUNCTION public.hrm_allowance_payroll_input_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM allowance payroll input % is retained as history — void it instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_allowance_payroll_input_no_delete_trigger ON public.hrm_allowance_payroll_inputs;
CREATE TRIGGER hrm_allowance_payroll_input_no_delete_trigger
  BEFORE DELETE ON public.hrm_allowance_payroll_inputs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_allowance_payroll_input_no_delete();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0184/0185 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all eight tables.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_work_classifications', 'hrm_rate_schedules',
    'hrm_rate_schedule_lines', 'hrm_employment_classifications',
    'hrm_per_diem_policies', 'hrm_per_diem_entries',
    'hrm_travel_pay_entries', 'hrm_allowance_payroll_inputs'] LOOP
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

COMMENT ON TABLE public.hrm_work_classifications IS
  'HRM work classifications (0223): the org''s trade taxonomy. Country-agnostic free text — no pack declares class lists. The journey_classification_id names the journey class an apprentice ratio counts against.';
COMMENT ON TABLE public.hrm_rate_schedules IS
  'HRM rate schedules (0223): prevailing-wage, union-agreement, or org-declared tables with 0193-shaped applies_to scoping plus project_ids and location_ids arrays. jurisdiction_code is pack vocabulary carried as free text; reciprocity is the org''s declared home_local / jobsite_local / higher_of rule.';
COMMENT ON TABLE public.hrm_rate_schedule_lines IS
  'HRM rate schedule lines (0223): one resolvable rate per schedule per classification per effective date. unique (schedule_id, classification_id, effective_from). fringe_rate is cash fringe; fringe_credit_rate is fringe paid to plans and creditable against the obligation.';
COMMENT ON TABLE public.hrm_employment_classifications IS
  'HRM employment classifications (0223): bitemporal assignment of an employment to a classification with the worker''s home local. History is kept by closing the active row and opening a new one, never by rewriting.';
COMMENT ON TABLE public.hrm_per_diem_policies IS
  'HRM per-diem policies (0223): org-declared computation rules per basis (flat_daily, distance_brackets, hours_threshold). rules shape is validated by the service''s zod schema per basis; taxable is an org declaration the pack interprets. The linked pay component must be kind earning (amounts paid to the worker price as earnings; taxability rides tax_treatment).';
COMMENT ON TABLE public.hrm_per_diem_entries IS
  'HRM per-diem entries (0223): one computed row per employment per project per day. unique (org_id, employment_id, project_id, worked_on). A void carries its reason; voided rows stay voided.';
COMMENT ON TABLE public.hrm_travel_pay_entries IS
  'HRM travel-pay entries (0223): same shape as per-diem, separate table so voids never cross between the two kinds.';
COMMENT ON TABLE public.hrm_allowance_payroll_inputs IS
  'HRM allowance pay-run input seam (0223): ONE ROW PER PER-DIEM OR TRAVEL ENTRY. HR sends AMOUNTS keyed by entry_id — payroll allocates them to pay periods and never recomputes. employee_party_id is the key the run reads; employment_id is provenance only. unique (org_id, entry_kind, entry_id). Voiding never clears consumed_by_run_document_id.';
