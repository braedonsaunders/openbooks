-- OpenBooks forward migration 0226_hrm_automations.
--
-- HR-16 the automation engine on Flows: triggers, rules, conditions,
-- actions, exception-only approval settings, the run log, and the durable
-- trigger-event queue. WHAT NEEDS STORAGE:
--
--   automations — one row per org automation recipe instance. trigger,
--   rules, conditions and actions are jsonb validated by the service
--   against zod discriminated unions (the trigger union is pinned by the
--   automations_trigger_shape CHECK so storage and the service agree on
--   the six kinds: schedule, date_relative, field_change, event, document,
--   manual). status in (draft, enabled, disabled, error). version bumps on
--   every edit; runs record the version they executed so an audit can
--   replay exactly what fired.
--
--   automation_runs — the append-only run log the inbox shows. One row per
--   (automation, subject, trigger fingerprint): the UNIQUE on
--   (org_id, automation_id, subject_kind, subject_id,
--   trigger_fingerprint) is the idempotency key, so a re-fired trigger
--   never double-runs. steps jsonb records each action's outcome; error
--   jsonb carries the failure. Rows are never updated except to close an
--   open run (queued/running -> terminal), and never deleted.
--
--   automation_approval_settings — per (org, subject_kind) exception-only
--   approval configuration: thresholds jsonb the exception scorer checks
--   by name, auto_approve_when_no_rule, delegate_after_days (nullable),
--   exclude_initiator (default true). Exception-only is a SETTING, not a
--   feature gate — the automations feature gates the builder, this table
--   only tunes Flows gates that already exist.
--
--   automation_event_queue — the durable trigger staging log. Entity write
--   services (employment, leave, files) INSERT a row in-transaction with
--   the trigger fingerprint and payload and NEVER call the engine inline;
--   the automations tick drains claimed rows and fires matching
--   field_change / event / document automations. A staging table rather
--   than scheduler_outbox because outbox dispatch lives in the scheduling
--   engine module, which cannot depend on the new automations module
--   without growing the pinned engine dependency cycle — the behavior is
--   identical (durable, in-transaction, async, claimed exactly once).
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

-- (1) Automations.
CREATE TABLE IF NOT EXISTS public.automations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  trigger jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority integer NOT NULL DEFAULT 100,
  last_run_at timestamp with time zone,
  error_message text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_status') THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_status CHECK (status IN ('draft', 'enabled', 'disabled', 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_name') THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_name CHECK (char_length(btrim(name)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_trigger_shape') THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_trigger_shape CHECK (
        jsonb_typeof(trigger) = 'object'
        AND trigger ? 'kind'
        AND trigger ->> 'kind' IN ('schedule', 'date_relative', 'field_change', 'event', 'document', 'manual')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_rules_shape') THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_rules_shape CHECK (jsonb_typeof(rules) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_conditions_shape') THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_conditions_shape CHECK (jsonb_typeof(conditions) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_actions_shape') THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_actions_shape CHECK (jsonb_typeof(actions) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automations_version_floor') THEN
    ALTER TABLE public.automations
      ADD CONSTRAINT automations_version_floor CHECK (version >= 1);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS automations_org_name_unique
  ON public.automations (org_id, name);
CREATE INDEX IF NOT EXISTS automations_org_status
  ON public.automations (org_id, status);

-- (2) Automation runs (append-only log + idempotency key).
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  automation_id uuid NOT NULL REFERENCES public.automations(id),
  version integer NOT NULL,
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  subject_kind text,
  subject_id uuid,
  status text NOT NULL DEFAULT 'queued',
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  error jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger_fingerprint text NOT NULL DEFAULT '',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_runs_status') THEN
    ALTER TABLE public.automation_runs
      ADD CONSTRAINT automation_runs_status CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed', 'skipped_no_match', 'simulated')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_runs_version_floor') THEN
    ALTER TABLE public.automation_runs
      ADD CONSTRAINT automation_runs_version_floor CHECK (version >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_runs_steps_shape') THEN
    ALTER TABLE public.automation_runs
      ADD CONSTRAINT automation_runs_steps_shape CHECK (jsonb_typeof(steps) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_runs_subject_pair') THEN
    ALTER TABLE public.automation_runs
      ADD CONSTRAINT automation_runs_subject_pair CHECK (
        (subject_kind IS NULL AND subject_id IS NULL)
        OR (subject_kind IS NOT NULL AND subject_id IS NOT NULL)
      );
  END IF;
END $$;

-- The idempotency key: a re-fired trigger collapses onto one run row.
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_idempotency_unique
  ON public.automation_runs (org_id, automation_id, subject_kind, subject_id, trigger_fingerprint);
CREATE INDEX IF NOT EXISTS automation_runs_automation
  ON public.automation_runs (org_id, automation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_status
  ON public.automation_runs (org_id, status);

-- (3) Exception-only approval settings per subject kind.
CREATE TABLE IF NOT EXISTS public.automation_approval_settings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subject_kind text NOT NULL,
  exception_only boolean NOT NULL DEFAULT false,
  thresholds jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_approve_when_no_rule boolean NOT NULL DEFAULT false,
  delegate_after_days integer,
  exclude_initiator boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_approval_settings_subject') THEN
    ALTER TABLE public.automation_approval_settings
      ADD CONSTRAINT automation_approval_settings_subject CHECK (char_length(btrim(subject_kind)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_approval_settings_thresholds') THEN
    ALTER TABLE public.automation_approval_settings
      ADD CONSTRAINT automation_approval_settings_thresholds CHECK (jsonb_typeof(thresholds) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_approval_settings_delegate_floor') THEN
    ALTER TABLE public.automation_approval_settings
      ADD CONSTRAINT automation_approval_settings_delegate_floor CHECK (
        delegate_after_days IS NULL OR delegate_after_days >= 1
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS automation_approval_settings_org_subject_unique
  ON public.automation_approval_settings (org_id, subject_kind);

-- (4) Durable trigger-event staging log.
CREATE TABLE IF NOT EXISTS public.automation_event_queue (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  event_kind text NOT NULL,
  subject_kind text,
  subject_id uuid,
  trigger_fingerprint text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  claimed_at timestamp with time zone,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_event_queue_kind') THEN
    ALTER TABLE public.automation_event_queue
      ADD CONSTRAINT automation_event_queue_kind CHECK (char_length(btrim(event_kind)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_event_queue_fingerprint') THEN
    ALTER TABLE public.automation_event_queue
      ADD CONSTRAINT automation_event_queue_fingerprint CHECK (char_length(btrim(trigger_fingerprint)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_event_queue_status') THEN
    ALTER TABLE public.automation_event_queue
      ADD CONSTRAINT automation_event_queue_status CHECK (status IN ('pending', 'claimed', 'done', 'failed'));
  END IF;
END $$;

-- Dedupe: the same trigger firing twice stages once; the runs table
-- idempotency key is the second fence.
CREATE UNIQUE INDEX IF NOT EXISTS automation_event_queue_dedupe_unique
  ON public.automation_event_queue (org_id, event_kind, subject_kind, subject_id, trigger_fingerprint);
CREATE INDEX IF NOT EXISTS automation_event_queue_pending
  ON public.automation_event_queue (status, created_at) WHERE status = 'pending';

-- Tenant RLS (0195 pattern): ENABLE + FORCE with org_isolation USING + WITH
-- CHECK on all four tables.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'automations', 'automation_runs',
    'automation_approval_settings', 'automation_event_queue'] LOOP
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

COMMENT ON TABLE public.automations IS
  'HRM automations (0226): org trigger/rule/condition/action recipes versioned on every edit; the builder behind the automations feature.';
COMMENT ON TABLE public.automation_runs IS
  'HRM automation run log (0226): append-only evidence of every firing, keyed idempotent so a re-fired trigger never double-runs.';
COMMENT ON TABLE public.automation_approval_settings IS
  'HRM exception-only approval tuning (0226): per-subject thresholds and delegation timing over the existing Flows gates.';
COMMENT ON TABLE public.automation_event_queue IS
  'HRM automation trigger staging (0226): durable in-transaction event rows drained by the automations tick; writers never call the engine inline.';
