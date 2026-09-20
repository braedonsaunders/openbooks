-- OpenBooks forward migration 0224_hrm_construction_certified.
--
-- HR-13 construction compliance (certified payroll runs, comp classes,
-- apprentice ratios, compliance findings). Companion to 0223 (rate tables,
-- classifications, per-diem). Same country-agnostic doctrine: class codes,
-- match shapes and format keys are org-declared or pack-declared; the
-- generic layer branches on nothing.
--
-- Tables (all org-scoped, all under the org_isolation RLS below):
--   hrm_comp_classes            workers'-comp / premium class taxonomy with
--                               the rate per 100 of payroll where declared.
--   hrm_comp_class_rules        priority-ordered match rules; the resolver
--                               takes the highest-priority match and REFUSES
--                               when nothing matches — never a silent
--                               default class.
--   hrm_certified_payroll_runs  frozen certified-payroll report data: one
--                               row per worker per classification per day.
--                               format_key is a PACK artefact key; amends
--                               link to the original run they supersede.
--   hrm_apprentice_ratio_rules  journey:apprentice ratios per schedule,
--                               measured daily or weekly.
--   hrm_compliance_findings     append-only pre-run flags (ratio_breach,
--                               missing_rate, class_unresolved,
--                               registration_missing, fringe_mismatch) also
--                               read by HR-21. Transitions append rows;
--                               status moves are updates with a reason, and
--                               deletes are refused outside the governed
--                               amend path.
--
-- Additive only. No backfill, no existing table altered, nothing exposed
-- to the generic governed-query catalog.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- (1) Comp classes and their priority match rules.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_comp_classes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  jurisdiction_code text,
  rate_per_100 numeric(19,4),
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_comp_classes_code
    CHECK (char_length(btrim(code)) > 0),
  CONSTRAINT hrm_comp_classes_name
    CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT hrm_comp_classes_rate
    CHECK (rate_per_100 IS NULL OR rate_per_100 >= 0),
  CONSTRAINT hrm_comp_classes_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_comp_classes_org_id_id_unique
  ON public.hrm_comp_classes (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_comp_classes_org_code_unique
  ON public.hrm_comp_classes (org_id, code);

CREATE TABLE IF NOT EXISTS public.hrm_comp_class_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  priority integer NOT NULL,
  match jsonb NOT NULL,
  comp_class_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_comp_class_rules_priority
    CHECK (priority >= 0),
  CONSTRAINT hrm_comp_class_rules_match_shape
    CHECK (jsonb_typeof(match) = 'object'
      AND (match - 'project_id' - 'cost_code_id' - 'department_id' - 'classification_id' - 'state_code') = '{}'::jsonb)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_comp_class_rules_org_id_id_unique
  ON public.hrm_comp_class_rules (org_id, id);
CREATE INDEX IF NOT EXISTS hrm_comp_class_rules_org_priority
  ON public.hrm_comp_class_rules (org_id, priority DESC);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_class_rules_class_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_class_rules
    ADD CONSTRAINT hrm_comp_class_rules_class_fkey
    FOREIGN KEY (org_id, comp_class_id) REFERENCES public.hrm_comp_classes (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (2) Certified payroll runs: the frozen report payload plus its artefact.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_certified_payroll_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  project_id uuid,
  week_ending date NOT NULL,
  schedule_id uuid,
  status text NOT NULL DEFAULT 'draft',
  payroll_run_document_ids uuid[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{"rows":[]}'::jsonb,
  format_key text NOT NULL,
  file_id uuid,
  generated_at timestamp with time zone,
  submitted_at timestamp with time zone,
  amends_run_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_certified_payroll_runs_status
    CHECK (status IN ('draft', 'generated', 'submitted', 'amended')),
  CONSTRAINT hrm_certified_payroll_runs_format
    CHECK (char_length(btrim(format_key)) > 0),
  CONSTRAINT hrm_certified_payroll_runs_payload_shape
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT hrm_certified_payroll_runs_submitted
    CHECK ((status = 'submitted' AND submitted_at IS NOT NULL) OR (status <> 'submitted')),
  CONSTRAINT hrm_certified_payroll_runs_generated
    CHECK ((status IN ('generated', 'submitted', 'amended') AND generated_at IS NOT NULL) OR (status = 'draft'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_certified_payroll_runs_org_id_id_unique
  ON public.hrm_certified_payroll_runs (org_id, id);
-- One live run per project per week per format; amends versions share the
-- week under distinct amends_run_id links, and NULLS NOT DISTINCT keeps a
-- second "original" (amends_run_id NULL) from slipping past the unique.
CREATE UNIQUE INDEX IF NOT EXISTS hrm_certified_payroll_runs_week_unique
  ON public.hrm_certified_payroll_runs (org_id, project_id, week_ending, format_key, amends_run_id) NULLS NOT DISTINCT;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_certified_payroll_runs_amends_fkey') THEN
  ALTER TABLE ONLY public.hrm_certified_payroll_runs
    ADD CONSTRAINT hrm_certified_payroll_runs_amends_fkey
    FOREIGN KEY (org_id, amends_run_id) REFERENCES public.hrm_certified_payroll_runs (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (3) Apprentice ratio rules: journey:apprentice per schedule.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_apprentice_ratio_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  journey_classification_id uuid NOT NULL,
  apprentice_classification_id uuid NOT NULL,
  ratio_journey integer NOT NULL,
  ratio_apprentice integer NOT NULL,
  measured text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_apprentice_ratio_rules_ratio
    CHECK (ratio_journey > 0 AND ratio_apprentice > 0),
  CONSTRAINT hrm_apprentice_ratio_rules_measured
    CHECK (measured IN ('daily', 'weekly')),
  CONSTRAINT hrm_apprentice_ratio_rules_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT hrm_apprentice_ratio_rules_distinct_classes
    CHECK (journey_classification_id <> apprentice_classification_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_apprentice_ratio_rules_org_id_id_unique
  ON public.hrm_apprentice_ratio_rules (org_id, id);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_apprentice_ratio_rules_schedule_fkey') THEN
  ALTER TABLE ONLY public.hrm_apprentice_ratio_rules
    ADD CONSTRAINT hrm_apprentice_ratio_rules_schedule_fkey
    FOREIGN KEY (org_id, schedule_id) REFERENCES public.hrm_rate_schedules (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_apprentice_ratio_rules_journey_fkey') THEN
  ALTER TABLE ONLY public.hrm_apprentice_ratio_rules
    ADD CONSTRAINT hrm_apprentice_ratio_rules_journey_fkey
    FOREIGN KEY (org_id, journey_classification_id) REFERENCES public.hrm_work_classifications (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_apprentice_ratio_rules_apprentice_fkey') THEN
  ALTER TABLE ONLY public.hrm_apprentice_ratio_rules
    ADD CONSTRAINT hrm_apprentice_ratio_rules_apprentice_fkey
    FOREIGN KEY (org_id, apprentice_classification_id) REFERENCES public.hrm_work_classifications (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (4) Compliance findings: append-only pre-run flags.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_compliance_findings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  kind text NOT NULL,
  project_id uuid,
  worked_on date,
  employment_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  resolved_reason text,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_compliance_findings_kind
    CHECK (kind IN ('ratio_breach', 'missing_rate', 'class_unresolved', 'registration_missing', 'fringe_mismatch')),
  CONSTRAINT hrm_compliance_findings_status
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  CONSTRAINT hrm_compliance_findings_resolved_reason
    CHECK ((status = 'resolved' AND resolved_reason IS NOT NULL AND char_length(btrim(resolved_reason)) > 0)
        OR (status <> 'resolved')),
  CONSTRAINT hrm_compliance_findings_detail_shape
    CHECK (jsonb_typeof(detail) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_compliance_findings_org_id_id_unique
  ON public.hrm_compliance_findings (org_id, id);
CREATE INDEX IF NOT EXISTS hrm_compliance_findings_org_status
  ON public.hrm_compliance_findings (org_id, status);
CREATE INDEX IF NOT EXISTS hrm_compliance_findings_org_project_day
  ON public.hrm_compliance_findings (org_id, project_id, worked_on);

CREATE OR REPLACE FUNCTION public.hrm_compliance_findings_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM compliance finding % is append-only audit evidence — acknowledge or resolve it instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_compliance_findings_no_delete_trigger ON public.hrm_compliance_findings;
CREATE TRIGGER hrm_compliance_findings_no_delete_trigger
  BEFORE DELETE ON public.hrm_compliance_findings
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compliance_findings_no_delete();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0184/0185 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all five tables.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_comp_classes', 'hrm_comp_class_rules',
    'hrm_certified_payroll_runs', 'hrm_apprentice_ratio_rules',
    'hrm_compliance_findings'] LOOP
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

COMMENT ON TABLE public.hrm_comp_classes IS
  'HRM workers-comp premium classes (0224): the org''s class taxonomy with the rate per 100 where declared. jurisdiction_code is pack vocabulary carried as free text.';
COMMENT ON TABLE public.hrm_comp_class_rules IS
  'HRM comp-class match rules (0224): priority-ordered; the resolver takes the highest-priority match and refuses when nothing matches — never a silent default class.';
COMMENT ON TABLE public.hrm_certified_payroll_runs IS
  'HRM certified payroll runs (0224): the FROZEN report payload (one row per worker per classification per day) plus the rendered pack artefact. format_key is a pack-declared artefact key; amends_run_id links an amendment to the run it supersedes.';
COMMENT ON TABLE public.hrm_apprentice_ratio_rules IS
  'HRM apprentice ratio rules (0224): journey:apprentice ratios per schedule measured daily or weekly. A breach prices the apprentice hours at the journey line — both visible, neither silent.';
COMMENT ON TABLE public.hrm_compliance_findings IS
  'HRM compliance findings (0224): append-only pre-run flags (ratio_breach, missing_rate, class_unresolved, registration_missing, fringe_mismatch) read by the certified-payroll generator and HR-21. Resolve carries its reason; deletes are refused.';
