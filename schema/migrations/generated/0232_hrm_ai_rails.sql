-- OpenBooks forward migration 0232_hrm_ai_rails.
--
-- HR-21 AI on the rails: every AI capability is a TOOL or a DETERMINISTIC
-- service, never a free-text feature. The LLM phrases and drafts; services
-- compute. WHAT NEEDS STORAGE:
--
--   ai_capabilities — the code registry mirrored per org: key matches the
--   feature/tool key, autonomy is read_only, draft, propose or
--   act_with_confirmation (never autonomous), the org may edit autonomy
--   DOWN only (the service refuses raises above the code maximum).
--   Unique per (org, key).
--
--   ai_decisions — the append-only decision log: input/output digests
--   (hashes, never prompts), a one-line PII-free summary, the record ids
--   cited, the outcome, and the human reviewer. A refuse-update trigger
--   rejects UPDATE and DELETE; corrections are new rows.
--
--   payroll_anomaly_flags — deterministic pre-run payroll and timesheet
--   anomaly flags, written idempotently by rescan: the UNIQUE on
--   (org, period, employment, kind, detail key) makes a rescan an
--   upsert of the same rows, never duplicates. Block severity refuses
--   the pay-run commit while open; warn never blocks.
--
--   anomaly_baselines — per-cohort mean/stddev windows the baseline rules
--   compare against; recomputed by a job, read by the scan.
--
--   nl_report_drafts — natural-language report questions with the VALIDATED
--   report-engine definition they produced (never SQL), plus lifecycle.
--
-- Additive only. No backfill (capabilities seed from the code registry when
-- a feature turns on), no RLS change to existing tables, no GENERATED
-- column, no change to any existing CHECK member.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- (1) Capability registry mirror.
CREATE TABLE IF NOT EXISTS public.ai_capabilities (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  purpose text NOT NULL,
  data_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  autonomy text NOT NULL DEFAULT 'read_only',
  reviewer_role text,
  notice_required boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  last_reviewed_at timestamp with time zone,
  reviewed_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_capabilities_key') THEN
    ALTER TABLE public.ai_capabilities
      ADD CONSTRAINT ai_capabilities_key CHECK (char_length(btrim(key)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_capabilities_name') THEN
    ALTER TABLE public.ai_capabilities
      ADD CONSTRAINT ai_capabilities_name CHECK (char_length(btrim(name)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_capabilities_purpose') THEN
    ALTER TABLE public.ai_capabilities
      ADD CONSTRAINT ai_capabilities_purpose CHECK (char_length(btrim(purpose)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_capabilities_autonomy') THEN
    ALTER TABLE public.ai_capabilities
      ADD CONSTRAINT ai_capabilities_autonomy CHECK (autonomy IN (
        'read_only', 'draft', 'propose', 'act_with_confirmation'
      ));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_capabilities_org_key_unique
  ON public.ai_capabilities (org_id, key);
CREATE INDEX IF NOT EXISTS ai_capabilities_org_enabled
  ON public.ai_capabilities (org_id) WHERE enabled;

-- (2) Append-only decision log.
CREATE TABLE IF NOT EXISTS public.ai_decisions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  capability_key text NOT NULL,
  actor_user_id uuid NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid,
  input_digest text NOT NULL,
  output_digest text NOT NULL,
  output_summary text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome text NOT NULL,
  human_reviewer uuid,
  reviewed_at timestamp with time zone,
  model text NOT NULL,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_decisions_capability') THEN
    ALTER TABLE public.ai_decisions
      ADD CONSTRAINT ai_decisions_capability CHECK (char_length(btrim(capability_key)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_decisions_digests') THEN
    ALTER TABLE public.ai_decisions
      ADD CONSTRAINT ai_decisions_digests CHECK (
        char_length(btrim(input_digest)) > 0 AND char_length(btrim(output_digest)) > 0
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_decisions_outcome') THEN
    ALTER TABLE public.ai_decisions
      ADD CONSTRAINT ai_decisions_outcome CHECK (outcome IN (
        'shown', 'accepted', 'edited', 'rejected', 'expired'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_decisions_subject') THEN
    ALTER TABLE public.ai_decisions
      ADD CONSTRAINT ai_decisions_subject CHECK (char_length(btrim(subject_kind)) > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_decisions_org_capability_recorded
  ON public.ai_decisions (org_id, capability_key, recorded_at DESC);
CREATE INDEX IF NOT EXISTS ai_decisions_org_actor
  ON public.ai_decisions (org_id, actor_user_id, recorded_at DESC);

-- Append-only: decisions are evidence. UPDATE and DELETE are refused; a
-- correction is a new row, exactly like the employment_changes ledger.
CREATE OR REPLACE FUNCTION public.ai_decisions_refuse_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'ai_decisions is append-only: decisions cannot be updated or deleted; record a new row (capability %, subject %)',
    COALESCE(OLD.capability_key, NEW.capability_key),
    COALESCE(OLD.subject_kind, NEW.subject_kind);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.ai_decisions_refuse_update() IS
  'openbooks:ai_decisions_append_only:v1 - refuses UPDATE and DELETE on ai_decisions; corrections are new rows';

DO $ai_decisions_refuse_update_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'ai_decisions'
       AND t.tgname = 'ai_decisions_refuse_update'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER ai_decisions_refuse_update
      BEFORE UPDATE OR DELETE ON public.ai_decisions
      FOR EACH ROW EXECUTE FUNCTION public.ai_decisions_refuse_update();
  END IF;
END
$ai_decisions_refuse_update_install$;

-- (3) Deterministic anomaly flags.
CREATE TABLE IF NOT EXISTS public.payroll_anomaly_flags (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  run_document_id uuid,
  pay_period_from date NOT NULL,
  pay_period_to date NOT NULL,
  employment_id uuid,
  kind text NOT NULL,
  severity text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolved_by uuid,
  resolved_at timestamp with time zone,
  reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_anomaly_flags_kind') THEN
    ALTER TABLE public.payroll_anomaly_flags
      ADD CONSTRAINT payroll_anomaly_flags_kind CHECK (kind IN (
        'terminated_with_pay', 'duplicate_bank', 'retro_spike', 'net_pay_spike',
        'zero_hours_with_pay', 'hours_spike', 'missing_rate', 'expired_rate',
        'prevailing_wage_missing', 'apprentice_ratio_breach', 'benefit_input_orphan',
        'leave_input_orphan', 'negative_balance', 'duplicate_entry', 'geofence_outside',
        'unrounded', 'custom'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_anomaly_flags_severity') THEN
    ALTER TABLE public.payroll_anomaly_flags
      ADD CONSTRAINT payroll_anomaly_flags_severity CHECK (severity IN ('info', 'warn', 'block'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_anomaly_flags_status') THEN
    ALTER TABLE public.payroll_anomaly_flags
      ADD CONSTRAINT payroll_anomaly_flags_status CHECK (status IN ('open', 'acknowledged', 'resolved', 'false_positive'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_anomaly_flags_period') THEN
    ALTER TABLE public.payroll_anomaly_flags
      ADD CONSTRAINT payroll_anomaly_flags_period CHECK (pay_period_from <= pay_period_to);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_anomaly_flags_resolution') THEN
    ALTER TABLE public.payroll_anomaly_flags
      ADD CONSTRAINT payroll_anomaly_flags_resolution CHECK (
        (status IN ('open', 'acknowledged'))
        OR (resolved_at IS NOT NULL AND char_length(btrim(COALESCE(reason, ''))) > 0)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_anomaly_flags_explanation') THEN
    ALTER TABLE public.payroll_anomaly_flags
      ADD CONSTRAINT payroll_anomaly_flags_explanation CHECK (char_length(btrim(explanation)) > 0);
  END IF;
END $$;

-- Idempotent rescan: one row per (org, period, employment, kind, detail key).
-- employment_id and the detail key are nullable, so both are normalized with
-- COALESCE — plain NULL columns never conflict and would let rescans
-- duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_anomaly_flags_rescan_unique
  ON public.payroll_anomaly_flags (
    org_id, pay_period_from, pay_period_to,
    COALESCE(employment_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind, COALESCE(detail->>'key', '')
  );
CREATE INDEX IF NOT EXISTS payroll_anomaly_flags_org_period_status
  ON public.payroll_anomaly_flags (org_id, pay_period_from, pay_period_to, status);
CREATE INDEX IF NOT EXISTS payroll_anomaly_flags_org_severity_status
  ON public.payroll_anomaly_flags (org_id, severity, status);

-- (4) Cohort baselines for the z-threshold rules.
CREATE TABLE IF NOT EXISTS public.anomaly_baselines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  cohort_key text NOT NULL,
  metric text NOT NULL,
  window_periods integer NOT NULL,
  mean numeric NOT NULL,
  stddev numeric NOT NULL,
  computed_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anomaly_baselines_metric') THEN
    ALTER TABLE public.anomaly_baselines
      ADD CONSTRAINT anomaly_baselines_metric CHECK (metric IN ('net_pay', 'hours', 'gross'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anomaly_baselines_window') THEN
    ALTER TABLE public.anomaly_baselines
      ADD CONSTRAINT anomaly_baselines_window CHECK (window_periods >= 2);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anomaly_baselines_spread') THEN
    ALTER TABLE public.anomaly_baselines
      ADD CONSTRAINT anomaly_baselines_spread CHECK (stddev >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anomaly_baselines_cohort') THEN
    ALTER TABLE public.anomaly_baselines
      ADD CONSTRAINT anomaly_baselines_cohort CHECK (char_length(btrim(cohort_key)) > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS anomaly_baselines_org_cohort_metric_unique
  ON public.anomaly_baselines (org_id, cohort_key, metric);

-- (5) Natural-language report drafts: the question plus the VALIDATED
-- report-engine definition it produced (never SQL) and its lifecycle.
CREATE TABLE IF NOT EXISTS public.nl_report_drafts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  question text NOT NULL,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'drafted',
  saved_report_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nl_report_drafts_question') THEN
    ALTER TABLE public.nl_report_drafts
      ADD CONSTRAINT nl_report_drafts_question CHECK (char_length(btrim(question)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nl_report_drafts_status') THEN
    ALTER TABLE public.nl_report_drafts
      ADD CONSTRAINT nl_report_drafts_status CHECK (status IN ('drafted', 'saved', 'discarded'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nl_report_drafts_saved') THEN
    ALTER TABLE public.nl_report_drafts
      ADD CONSTRAINT nl_report_drafts_saved CHECK (
        (status = 'saved' AND saved_report_id IS NOT NULL)
        OR (status <> 'saved')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS nl_report_drafts_org_user
  ON public.nl_report_drafts (org_id, user_id, created_at DESC);

-- (6) Org-declared AI rails settings: the z threshold, the retro amount
-- threshold, the baseline cohort key, the bias term list and the review
-- cadence. One row per org, seeded with safe defaults; Setup owns the UI.
CREATE TABLE IF NOT EXISTS public.ai_rails_settings (
  org_id uuid PRIMARY KEY,
  z_threshold numeric NOT NULL DEFAULT 3,
  retro_threshold numeric NOT NULL DEFAULT 500,
  cohort_key text NOT NULL DEFAULT 'subsidiary',
  bias_terms text[] NOT NULL DEFAULT '{}',
  review_months integer NOT NULL DEFAULT 12,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_rails_settings_z') THEN
    ALTER TABLE public.ai_rails_settings
      ADD CONSTRAINT ai_rails_settings_z CHECK (z_threshold > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_rails_settings_retro') THEN
    ALTER TABLE public.ai_rails_settings
      ADD CONSTRAINT ai_rails_settings_retro CHECK (retro_threshold >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_rails_settings_cohort') THEN
    ALTER TABLE public.ai_rails_settings
      ADD CONSTRAINT ai_rails_settings_cohort CHECK (cohort_key IN (
        'subsidiary', 'department', 'pay_schedule', 'job_level'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_rails_settings_review') THEN
    ALTER TABLE public.ai_rails_settings
      ADD CONSTRAINT ai_rails_settings_review CHECK (review_months >= 1 AND review_months <= 36);
  END IF;
END $$;

-- Tenant RLS (0195 pattern) for the six new tables.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'ai_capabilities', 'ai_decisions', 'payroll_anomaly_flags',
    'anomaly_baselines', 'nl_report_drafts', 'ai_rails_settings'
  ] LOOP
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

COMMENT ON TABLE public.ai_capabilities IS
  'HRM AI rails (0232): code-registry mirror of AI capabilities per org; autonomy may only be edited down from the code maximum.';
COMMENT ON TABLE public.ai_decisions IS
  'HRM AI rails (0232): append-only AI decision log — digests never prompts, one-line PII-free summaries, cited sources, outcomes, human reviewers.';
COMMENT ON TABLE public.payroll_anomaly_flags IS
  'HRM AI rails (0232): deterministic pre-run payroll/timesheet anomaly flags; block severity refuses the pay-run commit while open.';
COMMENT ON TABLE public.anomaly_baselines IS
  'HRM AI rails (0232): per-cohort mean/stddev windows for the anomaly baseline rules.';
COMMENT ON TABLE public.nl_report_drafts IS
  'HRM AI rails (0232): natural-language report questions with their validated report-engine definitions (never SQL).';
COMMENT ON TABLE public.ai_rails_settings IS
  'HRM AI rails (0232): org-declared thresholds, cohort key, bias terms and review cadence; Setup owns the UI.';
