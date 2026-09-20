-- OpenBooks forward migration 0222_hrm_headcount_plans_transparency.
--
-- Headcount plan scenarios and pay-transparency evidence (HR-12).
--
--   hrm_headcount_plans — one workforce plan per fiscal window: draft →
--   submitted → approved → closed. scope is the 0193 applies_to shape
--   with the same read-only generated-column projection 0221 uses, so
--   governed surfaces never read raw JSON.
--   hrm_headcount_plan_lines — one planned movement per plan: create
--   (no position until approved), backfill, change, or terminate.
--   est_annual_cost is COMPUTED at save from the band target (or the
--   incumbent rate) plus the org's declared burden rate through the
--   labor-costing burden service, stored beside its inputs in cost_basis
--   jsonb so the figure is explainable — never a typed number. approve
--   on a create/backfill line opens a requisition through the existing
--   recruiting requisition service (headcount = planned_fte rounded per
--   the org's declared FTE rounding setting); a hire against that
--   requisition marks the line filled. Terminate lines are INFORMATIONAL
--   and never end an employment (storage has no path that does).
--   hrm_pay_gap_snapshots — frozen Article 9 metrics computed by the
--   service from payroll truth (effective rates through the wage rate
--   service, never from bands): the seven metrics in metrics jsonb plus
--   per-category rows (level/family, counts, mean/median gaps, the OLS
--   unexplained gap, the method). Frozen at generation: the guard
--   refuses updates on every path, deletes only on the governed amend
--   path — a published equity figure is evidence, not a draft.
--   hrm_pay_information_requests — one worker request for their category
--   averages: due_at = requested_at + the org's declared response days
--   (the setting is required before the first request — the service
--   refuses by name without it); fulfil snapshots the person's category
--   averages from the latest snapshot covering their category and
--   refuses when none does.
--
-- Scope of THIS file: the four new tables, storage invariants, and RLS.
-- It alters no payroll or recruiting table, performs no backfill, and
-- registers no catalog refresh (HRM stays out of the generic
-- governed-query catalog like 0184/0192/0195/0221).
--
-- FINITE CIVIL TIME (0184 reader/storage contract): only finite AD civil
-- dates 0001-01-01..9999-12-31 and UTC stamps in the same years are savable.
-- NULL alone means unbounded; every non-null bound below is pinned.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_headcount_plans (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    fiscal_period_from date NOT NULL,
    fiscal_period_to date NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    -- 0193 applies_to shape: {employer_subsidiary_ids, department_ids}.
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- Read-only generated projections so governed surfaces never read raw
    -- JSON (the 0193 slots rule, same as 0221 cycles).
    scope_employer_subsidiary_id uuid
      GENERATED ALWAYS AS ((scope ->> 'employer_subsidiary_id')::uuid) STORED,
    scope_department_id uuid
      GENERATED ALWAYS AS ((scope ->> 'department_id')::uuid) STORED,
    revision integer NOT NULL DEFAULT 1,
    submitted_at timestamp with time zone,
    approved_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_headcount_plan_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    kind text NOT NULL,
    -- A create line names no position until approval opens the
    -- establishment; every other kind names its position from the start.
    position_id uuid,
    title text NOT NULL,
    department_id uuid,
    employer_subsidiary_id uuid NOT NULL,
    job_level_id uuid,
    planned_fte numeric(7,4) NOT NULL,
    start_on date NOT NULL,
    end_on date,
    -- COMPUTED at save from the band target (or the incumbent rate) plus
    -- the org's declared burden rate — stored beside its inputs in
    -- cost_basis so the figure is explainable, never a typed number.
    est_annual_cost numeric(19,4) NOT NULL,
    currency char(3) NOT NULL,
    cost_basis jsonb NOT NULL,
    status text NOT NULL DEFAULT 'proposed',
    -- Set when approval opens the requisition through the recruiting
    -- service; a hire against that requisition marks the line filled.
    requisition_id uuid,
    reason text,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_pay_gap_snapshots (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    as_of date NOT NULL,
    -- 0193 applies_to shape naming the measured population.
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- The seven Article 9 metrics (mean/median gaps, variable pay, Quartile
    -- proportions, headcounts) computed from payroll truth, plus the
    -- org-declared comparison attribute key and threshold they were
    -- computed under — a reader never has to guess the basis.
    metrics jsonb NOT NULL,
    -- Per-category rows: [{level_id, family_id, count_a, count_b,
    -- mean_gap_pct, median_gap_pct, unexplained_gap_pct, method,
    -- joint_assessment_due}]. Stored as jsonb (not a child table) so the
    -- snapshot is one frozen row: it cannot half-update.
    categories jsonb NOT NULL,
    generated_by uuid,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_pay_information_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    -- requested_at + the org's declared response days. The setting is
    -- required before the first request (the service refuses by name
    -- without it); storage pins only that a due date exists.
    due_at timestamp with time zone NOT NULL,
    fulfilled_at timestamp with time zone,
    -- The snapshot whose category averages answered the worker (null =
    -- unanswered). Points at a frozen row, so the answer never drifts.
    response_snapshot_id uuid,
    status text NOT NULL DEFAULT 'open',
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

-- ---------------------------------------------------------------------------
-- Primary keys.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plans_pkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plans ADD CONSTRAINT hrm_headcount_plans_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_pkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_gap_snapshots_pkey') THEN
  ALTER TABLE ONLY public.hrm_pay_gap_snapshots ADD CONSTRAINT hrm_pay_gap_snapshots_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_information_requests_pkey') THEN
  ALTER TABLE ONLY public.hrm_pay_information_requests ADD CONSTRAINT hrm_pay_information_requests_pkey PRIMARY KEY (id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Composite tenant identity (org_id, id) for every composite FK target.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plans_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_headcount_plans ADD CONSTRAINT hrm_headcount_plans_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_gap_snapshots_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_pay_gap_snapshots ADD CONSTRAINT hrm_pay_gap_snapshots_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Shape CHECKs (value sets pinned in storage; transitions in the service).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plans_name_not_blank') THEN
  ALTER TABLE ONLY public.hrm_headcount_plans ADD CONSTRAINT hrm_headcount_plans_name_not_blank
    CHECK (char_length(btrim(name)) > 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plans_status') THEN
  ALTER TABLE ONLY public.hrm_headcount_plans ADD CONSTRAINT hrm_headcount_plans_status CHECK (
    status IN ('draft', 'submitted', 'approved', 'closed')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plans_window') THEN
  ALTER TABLE ONLY public.hrm_headcount_plans ADD CONSTRAINT hrm_headcount_plans_window CHECK (
    fiscal_period_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    AND fiscal_period_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    AND fiscal_period_to >= fiscal_period_from
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plans_revision') THEN
  ALTER TABLE ONLY public.hrm_headcount_plans ADD CONSTRAINT hrm_headcount_plans_revision CHECK (revision >= 1); END IF; END $$;
-- The 0193 applies_to shape (see 0221): only the two slot keys, each a
-- uuid string or null; the shape CHECK stays the single authority.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plans_scope_shape') THEN
  ALTER TABLE ONLY public.hrm_headcount_plans ADD CONSTRAINT hrm_headcount_plans_scope_shape CHECK (
    jsonb_typeof(scope) = 'object'
    AND (scope - 'employer_subsidiary_id' - 'department_id') = '{}'::jsonb
    AND (NOT (scope ? 'employer_subsidiary_id')
         OR jsonb_typeof(scope -> 'employer_subsidiary_id') = 'null'
         OR (jsonb_typeof(scope -> 'employer_subsidiary_id') = 'string'
             AND scope ->> 'employer_subsidiary_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
    AND (NOT (scope ? 'department_id')
         OR jsonb_typeof(scope -> 'department_id') = 'null'
         OR (jsonb_typeof(scope -> 'department_id') = 'string'
             AND scope ->> 'department_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
  ); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_kind') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_kind CHECK (
    kind IN ('create', 'backfill', 'change', 'terminate')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_status') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_status CHECK (
    status IN ('proposed', 'approved', 'rejected', 'opened', 'filled', 'cancelled')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_title_not_blank') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_title_not_blank
    CHECK (char_length(btrim(title)) > 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_fte_positive') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_fte_positive
    CHECK (planned_fte > 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_window') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_window CHECK (
    start_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    AND (end_on IS NULL
      OR (end_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
        AND end_on >= start_on))
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_cost_nonneg') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_cost_nonneg
    CHECK (est_annual_cost >= 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_cost_basis_shape') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_cost_basis_shape CHECK (
    jsonb_typeof(cost_basis) = 'object'
    AND (cost_basis ? 'basis')
    AND (cost_basis ? 'burden_rate')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_create_has_no_position') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_create_has_no_position CHECK (
    (kind = 'create' AND status IN ('proposed', 'approved') AND position_id IS NULL)
    OR (kind <> 'create')
    OR (status NOT IN ('proposed', 'approved'))
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_requisition_paired') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_requisition_paired CHECK (
    (status IN ('opened', 'filled') AND requisition_id IS NOT NULL)
    OR (status IN ('proposed', 'approved', 'rejected', 'cancelled'))
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_revision') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_revision CHECK (revision >= 1); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_gap_snapshots_as_of_finite') THEN
  ALTER TABLE ONLY public.hrm_pay_gap_snapshots ADD CONSTRAINT hrm_pay_gap_snapshots_as_of_finite CHECK (
    as_of BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_gap_snapshots_metrics_shape') THEN
  ALTER TABLE ONLY public.hrm_pay_gap_snapshots ADD CONSTRAINT hrm_pay_gap_snapshots_metrics_shape CHECK (
    jsonb_typeof(metrics) = 'object'
    AND (metrics ? 'comparison_attribute_key')
    AND (metrics ? 'threshold_pct')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_gap_snapshots_categories_shape') THEN
  ALTER TABLE ONLY public.hrm_pay_gap_snapshots ADD CONSTRAINT hrm_pay_gap_snapshots_categories_shape CHECK (
    jsonb_typeof(categories) = 'array'
  ); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_information_requests_status') THEN
  ALTER TABLE ONLY public.hrm_pay_information_requests ADD CONSTRAINT hrm_pay_information_requests_status CHECK (
    status IN ('open', 'fulfilled', 'refused')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_information_requests_outcome_paired') THEN
  ALTER TABLE ONLY public.hrm_pay_information_requests ADD CONSTRAINT hrm_pay_information_requests_outcome_paired CHECK (
    (status = 'open' AND fulfilled_at IS NULL)
    OR (status = 'fulfilled' AND fulfilled_at IS NOT NULL AND response_snapshot_id IS NOT NULL)
    OR (status = 'refused' AND fulfilled_at IS NOT NULL)
  ); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Tenant FKs (composite, same-org) and the org anchors.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plans_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plans ADD CONSTRAINT hrm_headcount_plans_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_plan_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_plan_tenant_fkey
    FOREIGN KEY (org_id, plan_id) REFERENCES public.hrm_headcount_plans(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_position_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_position_tenant_fkey
    FOREIGN KEY (org_id, position_id) REFERENCES public.positions(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_department_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_department_tenant_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_employer_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_employer_tenant_fkey
    FOREIGN KEY (org_id, employer_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_level_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_level_tenant_fkey
    FOREIGN KEY (org_id, job_level_id) REFERENCES public.hrm_job_levels(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_headcount_plan_lines_requisition_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_headcount_plan_lines ADD CONSTRAINT hrm_headcount_plan_lines_requisition_tenant_fkey
    FOREIGN KEY (org_id, requisition_id) REFERENCES public.hrm_requisitions(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_gap_snapshots_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_gap_snapshots ADD CONSTRAINT hrm_pay_gap_snapshots_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_information_requests_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_information_requests ADD CONSTRAINT hrm_pay_information_requests_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_information_requests_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_information_requests ADD CONSTRAINT hrm_pay_information_requests_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_information_requests_snapshot_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_information_requests ADD CONSTRAINT hrm_pay_information_requests_snapshot_tenant_fkey
    FOREIGN KEY (org_id, response_snapshot_id) REFERENCES public.hrm_pay_gap_snapshots(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Frozen-evidence guards: a published gap snapshot or a decided plan line
-- is history. Snapshots are frozen outright (regeneration is a new row);
-- decided plan lines move only through the service lifecycle. Deletes only
-- on the governed amend path.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hrm_compensation_plans_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  -- A published equity figure is evidence, not a draft: updates refused on
  -- every path, deletes only on the governed amend path — compute a new
  -- snapshot instead of editing one.
  IF TG_TABLE_NAME = 'hrm_pay_gap_snapshots' AND TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'openbooks:immutable_evidence: % rows are frozen — compute a new snapshot instead of editing one', TG_TABLE_NAME
      USING ERRCODE = '25001';
  END IF;
  IF TG_OP = 'DELETE'
     AND current_setting('openbooks.amend', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'openbooks:immutable_evidence: % rows delete only on the governed amend path', TG_TABLE_NAME
      USING ERRCODE = '25001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_pay_gap_snapshots_frozen ON public.hrm_pay_gap_snapshots;
CREATE TRIGGER hrm_pay_gap_snapshots_frozen
  BEFORE UPDATE OR DELETE ON public.hrm_pay_gap_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compensation_plans_guard();
DROP TRIGGER IF EXISTS hrm_headcount_plans_history ON public.hrm_headcount_plans;
CREATE TRIGGER hrm_headcount_plans_history
  BEFORE DELETE ON public.hrm_headcount_plans
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compensation_plans_guard();
DROP TRIGGER IF EXISTS hrm_headcount_plan_lines_history ON public.hrm_headcount_plan_lines;
CREATE TRIGGER hrm_headcount_plan_lines_history
  BEFORE DELETE ON public.hrm_headcount_plan_lines
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compensation_plans_guard();
DROP TRIGGER IF EXISTS hrm_pay_information_requests_history ON public.hrm_pay_information_requests;
CREATE TRIGGER hrm_pay_information_requests_history
  BEFORE DELETE ON public.hrm_pay_information_requests
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compensation_plans_guard();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0177/0181 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all four tables. HRM stays out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_headcount_plans', 'hrm_headcount_plan_lines',
    'hrm_pay_gap_snapshots', 'hrm_pay_information_requests'] LOOP
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

COMMENT ON TABLE public.hrm_headcount_plans IS
  'HRM workforce plans (0222): one plan per fiscal window, draft, submitted, approved, closed. Lines carry the movements; approval opens requisitions through the recruiting service.';
COMMENT ON TABLE public.hrm_headcount_plan_lines IS
  'HRM planned movements (0222): create (no position until approved), backfill, change, terminate — terminate is informational and never ends an employment. Cost is computed at save with its inputs in cost_basis, never typed.';
COMMENT ON TABLE public.hrm_pay_gap_snapshots IS
  'HRM pay-equity evidence (0222): frozen Article 9 metrics computed from payroll truth with per-category gaps and the OLS unexplained gap. Frozen at generation — a new snapshot supersedes, never edits.';
COMMENT ON TABLE public.hrm_pay_information_requests IS
  'HRM worker pay-information requests (0222): due at request plus the org-declared response days; fulfilment points at the frozen snapshot whose category averages answered the worker.';
