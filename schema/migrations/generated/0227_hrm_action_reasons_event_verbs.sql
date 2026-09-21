-- OpenBooks forward migration 0227_hrm_action_reasons_event_verbs.
--
-- HR-16 action/reason codes and cancel / rescind / correct. WHAT NEEDS
-- STORAGE:
--
--   hrm_action_reasons — the Setup-owned vocabulary of reason codes per
--   generic HR action (hire, rehire, transfer, promotion, demotion,
--   pay_change, manager_change, location_change, schedule_change,
--   leave_of_absence, return, termination, profile_change, other). The
--   action CHECK pins the generic vocabulary so a reason can never be
--   filed under a misspelled action; requires_comment forces the
--   operator to write the sentence the audit needs. Unique per
--   (org, action, reason_code).
--
--   hrm_employment_change_requests gains action + reason_code (nullable:
--   orgs with the hrmActionReasons feature off never supply them, and
--   existing drafts read null = unclassified). When the feature is on the
--   SERVICE requires both on submit — storage stays permissive because
--   the gate is a product rule, not a row invariant.
--
--   employment_changes (the applied event) carries action, reason_code,
--   verb (apply, cancel, rescind, correct; default apply), plus
--   reverses_change_id (rescind names the change it reverses) and
--   corrected_change_id (correct names the change it supersedes). All
--   three verbs are EVENTS — appended rows, never edits of the prior
--   row, so the immutable ledger stays immutable.
--
-- Additive only. No backfill (existing rows read null/apply = the
-- pre-verb history was all applies), no RLS change, no GENERATED column,
-- no change to any existing CHECK member.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- (1) Reason-code vocabulary.
CREATE TABLE IF NOT EXISTS public.hrm_action_reasons (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  label text NOT NULL,
  requires_comment boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_action_reasons_action') THEN
    ALTER TABLE public.hrm_action_reasons
      ADD CONSTRAINT hrm_action_reasons_action CHECK (action IN (
        'hire', 'rehire', 'transfer', 'promotion', 'demotion', 'pay_change',
        'manager_change', 'location_change', 'schedule_change',
        'leave_of_absence', 'return', 'termination', 'profile_change', 'other'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_action_reasons_code') THEN
    ALTER TABLE public.hrm_action_reasons
      ADD CONSTRAINT hrm_action_reasons_code CHECK (char_length(btrim(reason_code)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_action_reasons_label') THEN
    ALTER TABLE public.hrm_action_reasons
      ADD CONSTRAINT hrm_action_reasons_label CHECK (char_length(btrim(label)) > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hrm_action_reasons_org_action_code_unique
  ON public.hrm_action_reasons (org_id, action, reason_code);
CREATE INDEX IF NOT EXISTS hrm_action_reasons_org_action
  ON public.hrm_action_reasons (org_id, action) WHERE is_active;

-- (2) Request columns (nullable: feature-off orgs never supply them).
ALTER TABLE public.hrm_employment_change_requests
  ADD COLUMN IF NOT EXISTS action text;
ALTER TABLE public.hrm_employment_change_requests
  ADD COLUMN IF NOT EXISTS reason_code text;

-- (3) Event columns (nullable action/reason, verb default apply).
ALTER TABLE public.employment_changes
  ADD COLUMN IF NOT EXISTS action text;
ALTER TABLE public.employment_changes
  ADD COLUMN IF NOT EXISTS reason_code text;
ALTER TABLE public.employment_changes
  ADD COLUMN IF NOT EXISTS verb text NOT NULL DEFAULT 'apply';
ALTER TABLE public.employment_changes
  ADD COLUMN IF NOT EXISTS reverses_change_id uuid;
ALTER TABLE public.employment_changes
  ADD COLUMN IF NOT EXISTS corrected_change_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_verb') THEN
    ALTER TABLE public.employment_changes
      ADD CONSTRAINT employment_changes_verb CHECK (verb IN ('apply', 'cancel', 'rescind', 'correct'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_verb_links') THEN
    ALTER TABLE public.employment_changes
      ADD CONSTRAINT employment_changes_verb_links CHECK (
        (verb = 'rescind' AND reverses_change_id IS NOT NULL AND corrected_change_id IS NULL)
        OR (verb = 'correct' AND corrected_change_id IS NOT NULL AND reverses_change_id IS NULL)
        OR (verb IN ('apply', 'cancel') AND reverses_change_id IS NULL AND corrected_change_id IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employment_changes_verb
  ON public.employment_changes (org_id, employment_id, verb);

-- Tenant RLS (0195 pattern) for the one new table.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['hrm_action_reasons'] LOOP
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

COMMENT ON TABLE public.hrm_action_reasons IS
  'HRM action reason codes (0227): Setup-owned vocabulary per generic HR action; required on submit only while the hrmActionReasons feature is on.';
