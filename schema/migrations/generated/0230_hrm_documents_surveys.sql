-- OpenBooks forward migration 0230_hrm_documents_surveys.
--
-- HR-19 hire-to-retire HR documents with e-sign, retention schedules with
-- audited deletion, one-click subject-access (DSAR) exports, engagement
-- surveys with anonymity-grade results, and the org-chart read model.
--
-- WHAT NEEDS STORAGE:
--
--   hrm_document_categories — the org-declared Setup vocabulary
--   (contract, policy, acknowledgment, letter, form, other — never an
--   enum). Templates, documents, and schedules name keys from this
--   list; the services refuse unknown keys against it.
--
--   hrm_document_templates — org-authored document shells (categories are
--   an org-declared Setup list, never an enum). body_template is mustache
--   merged at generate time through the packages/pdf idiom; merge_fields
--   declares the keys, resolved ONLY from the employment/person/org read
--   services through an allowlist in code. signer_roles is the ordered
--   role list [employee, manager, hr]; acknowledgment_only templates
--   never take signatures.
--
--   hrm_documents — one row per issued document for a person (party_id;
--   employment_id when issued in an employment context). file_id points
--   at the current rendered/uploaded file in the File Cabinet; every
--   re-render or signed-PDF append is a new file_versions row, never an
--   overwrite. status in (draft, sent, viewed, partially_signed, signed,
--   acknowledged, declined, voided, expired, deleted). retain_until is
--   COMPUTED at completion from the matching retention schedule and
--   STORED — recomputing from a schedule the org later edits would
--   reinterpret history. legal_hold freezes the retention tick.
--
--   hrm_document_signers — ordered signer rows. token_hash is UNIQUE: one
--   token, one signer, consumable once; evidence jsonb carries the HMAC
--   record (typed name, timestamp, ip hash, user-agent hash, document
--   hash at signing — the field-ticket signing primitive's shape).
--
--   hrm_document_events — append-only evidence ledger (created, sent,
--   viewed, signed, declined, acknowledged, voided, expired, reminded,
--   retention_flagged, deleted). Updates refused on every path by the
--   trigger below; deletes only on the governed amend path.
--
--   hrm_retention_schedules — one row per (org, category): retain_years
--   counted from completion, termination, or creation; terminal action
--   delete or anonymize. UNIQUE (org_id, category_key): a category with
--   two schedules is ambiguous, and ambiguity in deletion is refused.
--
--   hrm_retention_actions — append-only execution ledger: one row per
--   (document, schedule) due date. executed_at null = flagged, waiting
--   out the org's grace days; blocked_reason names the legal hold.
--   executed_by null = the scheduler did it.
--
--   hrm_data_subject_exports — DSAR queue. The zip is built in the
--   worker (never inline: it fans out across modules) and stored in the
--   File Cabinet with a grant to the requester only. scope jsonb records
--   which modules were included so the download can be audited.
--
--   hrm_surveys — engagement, pulse, onboarding, exit, custom. anonymity
--   in (anonymous, confidential, named): anonymous stores NO respondent
--   link anywhere (asserted null, not merely unused); confidential
--   stores the link encrypted with the org data key and never exposes it
--   below min_group_size; named stores it plain. audience is the
--   applies_to shape; recurrence carries the pulse cadence.
--
--   hrm_survey_questions — ordered question cards. driver_key is the
--   org-declared driver vocabulary heatmaps group by.
--
--   hrm_survey_invitations — one tokened invitation per respondent.
--   token_hash UNIQUE. For anonymous surveys the invitation records only
--   THAT a response happened (responded_at), never WHICH response.
--
--   hrm_survey_responses — one row per submission. respondent_link_enc
--   is null for anonymous surveys (the service asserts the column is
--   null — absence is the guarantee). segment_snapshot carries the
--   department/subsidiary/location/tenure band at submission for
--   heatmaps, and is null whenever the segment group at submission time
--   holds fewer than min_group_size invitees.
--
--   Org chart needs NO table: it reads reporting_relationships (line
--   relationships) with position titles as of a date. Both traversal
--   directions are already indexed (reporting_relationships_manager and
--   reporting_relationships_employment in 0184) — measured, no index
--   added here.
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

-- (0) Document categories: the org-declared Setup vocabulary templates,
-- documents, and retention schedules name. category_key columns stay text
-- (no FK: a category deleted mid-life must not strand issued documents),
-- and the services refuse unknown keys against this table — the Setup →
-- Workforce → Document Categories screen the refusal remedy names.
CREATE TABLE IF NOT EXISTS public.hrm_document_categories (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  key text NOT NULL,
  label text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_categories_key') THEN
    ALTER TABLE public.hrm_document_categories
      ADD CONSTRAINT hrm_document_categories_key CHECK (char_length(btrim(key)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_categories_label') THEN
    ALTER TABLE public.hrm_document_categories
      ADD CONSTRAINT hrm_document_categories_label CHECK (char_length(btrim(label)) > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hrm_document_categories_org_key
  ON public.hrm_document_categories (org_id, key);

-- (1) Document templates.
CREATE TABLE IF NOT EXISTS public.hrm_document_templates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  category_key text NOT NULL,
  body_template text NOT NULL,
  merge_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  requires_signature boolean NOT NULL DEFAULT false,
  signer_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  acknowledgment_only boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_templates_name') THEN
    ALTER TABLE public.hrm_document_templates
      ADD CONSTRAINT hrm_document_templates_name CHECK (char_length(btrim(name)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_templates_category') THEN
    ALTER TABLE public.hrm_document_templates
      ADD CONSTRAINT hrm_document_templates_category CHECK (char_length(btrim(category_key)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_templates_body') THEN
    ALTER TABLE public.hrm_document_templates
      ADD CONSTRAINT hrm_document_templates_body CHECK (char_length(btrim(body_template)) > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hrm_document_templates_org_name
  ON public.hrm_document_templates (org_id, name);
CREATE INDEX IF NOT EXISTS hrm_document_templates_org_category
  ON public.hrm_document_templates (org_id, category_key) WHERE is_active;

-- (2) Retention schedules (created before documents so the FK resolves).
CREATE TABLE IF NOT EXISTS public.hrm_retention_schedules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  category_key text NOT NULL,
  retain_years integer NOT NULL,
  from_event text NOT NULL,
  action text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_schedules_category') THEN
    ALTER TABLE public.hrm_retention_schedules
      ADD CONSTRAINT hrm_retention_schedules_category CHECK (char_length(btrim(category_key)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_schedules_years') THEN
    ALTER TABLE public.hrm_retention_schedules
      ADD CONSTRAINT hrm_retention_schedules_years CHECK (retain_years >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_schedules_from') THEN
    ALTER TABLE public.hrm_retention_schedules
      ADD CONSTRAINT hrm_retention_schedules_from CHECK (from_event IN ('completion', 'termination', 'creation'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_schedules_action') THEN
    ALTER TABLE public.hrm_retention_schedules
      ADD CONSTRAINT hrm_retention_schedules_action CHECK (action IN ('delete', 'anonymize'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hrm_retention_schedules_org_category
  ON public.hrm_retention_schedules (org_id, category_key);

-- (3) Documents.
CREATE TABLE IF NOT EXISTS public.hrm_documents (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  employment_id uuid,
  -- Nullable (not absent): the anonymize retention action clears the
  -- party link while the row and its events stay as deletion evidence.
  party_id uuid,
  template_id uuid,
  category_key text NOT NULL,
  title text NOT NULL,
  file_id uuid,
  status text NOT NULL DEFAULT 'draft',
  sent_at timestamp with time zone,
  completed_at timestamp with time zone,
  expires_at timestamp with time zone,
  retention_rule_id uuid,
  retain_until date,
  legal_hold boolean NOT NULL DEFAULT false,
  -- Set by void with the operator's reason (the events ledger keeps the
  -- fact; this keeps the words). Set to null-cleared values by the
  -- anonymize action: party_id null = delinked, title generic.
  void_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_documents_status') THEN
    ALTER TABLE public.hrm_documents
      ADD CONSTRAINT hrm_documents_status CHECK (status IN ('draft', 'sent', 'viewed', 'partially_signed', 'signed', 'acknowledged', 'declined', 'voided', 'expired', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_documents_title') THEN
    ALTER TABLE public.hrm_documents
      ADD CONSTRAINT hrm_documents_title CHECK (char_length(btrim(title)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_documents_category') THEN
    ALTER TABLE public.hrm_documents
      ADD CONSTRAINT hrm_documents_category CHECK (char_length(btrim(category_key)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_documents_file_fkey') THEN
    ALTER TABLE public.hrm_documents
      ADD CONSTRAINT hrm_documents_file_fkey FOREIGN KEY (file_id) REFERENCES public.files (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_documents_template_fkey') THEN
    ALTER TABLE public.hrm_documents
      ADD CONSTRAINT hrm_documents_template_fkey FOREIGN KEY (template_id) REFERENCES public.hrm_document_templates (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_documents_retention_fkey') THEN
    ALTER TABLE public.hrm_documents
      ADD CONSTRAINT hrm_documents_retention_fkey FOREIGN KEY (retention_rule_id) REFERENCES public.hrm_retention_schedules (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hrm_documents_org_party
  ON public.hrm_documents (org_id, party_id);
CREATE INDEX IF NOT EXISTS hrm_documents_org_status
  ON public.hrm_documents (org_id, status);
CREATE INDEX IF NOT EXISTS hrm_documents_retain_due
  ON public.hrm_documents (org_id, retain_until) WHERE retain_until IS NOT NULL AND status NOT IN ('deleted', 'voided');

-- (4) Document signers (ordered; one consumable token each).
CREATE TABLE IF NOT EXISTS public.hrm_document_signers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  ord integer NOT NULL,
  signer_party_id uuid NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  signed_at timestamp with time zone,
  evidence jsonb,
  decline_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_signers_ord') THEN
    ALTER TABLE public.hrm_document_signers
      ADD CONSTRAINT hrm_document_signers_ord CHECK (ord >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_signers_role') THEN
    ALTER TABLE public.hrm_document_signers
      ADD CONSTRAINT hrm_document_signers_role CHECK (role IN ('employee', 'manager', 'hr'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_signers_status') THEN
    ALTER TABLE public.hrm_document_signers
      ADD CONSTRAINT hrm_document_signers_status CHECK (status IN ('pending', 'viewed', 'signed', 'declined'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_signers_token') THEN
    ALTER TABLE public.hrm_document_signers
      ADD CONSTRAINT hrm_document_signers_token CHECK (char_length(btrim(token_hash)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_signers_document_fkey') THEN
    ALTER TABLE public.hrm_document_signers
      ADD CONSTRAINT hrm_document_signers_document_fkey FOREIGN KEY (document_id) REFERENCES public.hrm_documents (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hrm_document_signers_token_unique
  ON public.hrm_document_signers (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_document_signers_document_ord
  ON public.hrm_document_signers (document_id, ord);
CREATE INDEX IF NOT EXISTS hrm_document_signers_org_signer
  ON public.hrm_document_signers (org_id, signer_party_id, status);

-- (5) Document events (append-only evidence).
CREATE TABLE IF NOT EXISTS public.hrm_document_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  kind text NOT NULL,
  actor uuid,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_events_kind') THEN
    ALTER TABLE public.hrm_document_events
      ADD CONSTRAINT hrm_document_events_kind CHECK (kind IN ('created', 'sent', 'viewed', 'signed', 'declined', 'acknowledged', 'voided', 'expired', 'reminded', 'retention_flagged', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_document_events_document_fkey') THEN
    ALTER TABLE public.hrm_document_events
      ADD CONSTRAINT hrm_document_events_document_fkey FOREIGN KEY (document_id) REFERENCES public.hrm_documents (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hrm_document_events_document
  ON public.hrm_document_events (org_id, document_id, recorded_at);

-- (6) Retention actions (append-only execution ledger).
CREATE TABLE IF NOT EXISTS public.hrm_retention_actions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  due_on date NOT NULL,
  executed_at timestamp with time zone,
  action text NOT NULL,
  executed_by uuid,
  blocked_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_actions_action') THEN
    ALTER TABLE public.hrm_retention_actions
      ADD CONSTRAINT hrm_retention_actions_action CHECK (action IN ('delete', 'anonymize'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_actions_document_fkey') THEN
    ALTER TABLE public.hrm_retention_actions
      ADD CONSTRAINT hrm_retention_actions_document_fkey FOREIGN KEY (document_id) REFERENCES public.hrm_documents (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_actions_schedule_fkey') THEN
    ALTER TABLE public.hrm_retention_actions
      ADD CONSTRAINT hrm_retention_actions_schedule_fkey FOREIGN KEY (schedule_id) REFERENCES public.hrm_retention_schedules (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hrm_retention_actions_due
  ON public.hrm_retention_actions (org_id, due_on) WHERE executed_at IS NULL;
CREATE INDEX IF NOT EXISTS hrm_retention_actions_document
  ON public.hrm_retention_actions (org_id, document_id);

-- (7) Data-subject exports (DSAR queue).
CREATE TABLE IF NOT EXISTS public.hrm_data_subject_exports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  party_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamp with time zone DEFAULT now() NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  file_id uuid,
  scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamp with time zone,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_data_subject_exports_status') THEN
    ALTER TABLE public.hrm_data_subject_exports
      ADD CONSTRAINT hrm_data_subject_exports_status CHECK (status IN ('queued', 'ready', 'delivered', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_data_subject_exports_file_fkey') THEN
    ALTER TABLE public.hrm_data_subject_exports
      ADD CONSTRAINT hrm_data_subject_exports_file_fkey FOREIGN KEY (file_id) REFERENCES public.files (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hrm_data_subject_exports_org_party
  ON public.hrm_data_subject_exports (org_id, party_id, requested_at);
CREATE INDEX IF NOT EXISTS hrm_data_subject_exports_queued
  ON public.hrm_data_subject_exports (org_id, requested_at) WHERE status = 'queued';

-- (8) Surveys.
CREATE TABLE IF NOT EXISTS public.hrm_surveys (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  anonymity text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  opens_at timestamp with time zone,
  closes_at timestamp with time zone,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  recurrence jsonb,
  min_group_size integer NOT NULL DEFAULT 5,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_surveys_name') THEN
    ALTER TABLE public.hrm_surveys
      ADD CONSTRAINT hrm_surveys_name CHECK (char_length(btrim(name)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_surveys_kind') THEN
    ALTER TABLE public.hrm_surveys
      ADD CONSTRAINT hrm_surveys_kind CHECK (kind IN ('engagement', 'pulse', 'onboarding', 'exit', 'custom'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_surveys_anonymity') THEN
    ALTER TABLE public.hrm_surveys
      ADD CONSTRAINT hrm_surveys_anonymity CHECK (anonymity IN ('anonymous', 'confidential', 'named'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_surveys_status') THEN
    ALTER TABLE public.hrm_surveys
      ADD CONSTRAINT hrm_surveys_status CHECK (status IN ('draft', 'open', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_surveys_group') THEN
    ALTER TABLE public.hrm_surveys
      ADD CONSTRAINT hrm_surveys_group CHECK (min_group_size >= 2);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hrm_surveys_org_status
  ON public.hrm_surveys (org_id, status);

-- (9) Survey questions (ordered cards).
CREATE TABLE IF NOT EXISTS public.hrm_survey_questions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  survey_id uuid NOT NULL,
  position integer NOT NULL,
  kind text NOT NULL,
  prompt text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  driver_key text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_survey_questions_kind') THEN
    ALTER TABLE public.hrm_survey_questions
      ADD CONSTRAINT hrm_survey_questions_kind CHECK (kind IN ('scale', 'enps', 'text', 'single', 'multi'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_survey_questions_prompt') THEN
    ALTER TABLE public.hrm_survey_questions
      ADD CONSTRAINT hrm_survey_questions_prompt CHECK (char_length(btrim(prompt)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_survey_questions_position') THEN
    ALTER TABLE public.hrm_survey_questions
      ADD CONSTRAINT hrm_survey_questions_position CHECK (position >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_survey_questions_survey_fkey') THEN
    ALTER TABLE public.hrm_survey_questions
      ADD CONSTRAINT hrm_survey_questions_survey_fkey FOREIGN KEY (survey_id) REFERENCES public.hrm_surveys (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hrm_survey_questions_survey_position
  ON public.hrm_survey_questions (survey_id, position);
CREATE INDEX IF NOT EXISTS hrm_survey_questions_survey
  ON public.hrm_survey_questions (org_id, survey_id);

-- (10) Survey invitations (one consumable token each).
CREATE TABLE IF NOT EXISTS public.hrm_survey_invitations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  survey_id uuid NOT NULL,
  party_id uuid NOT NULL,
  token_hash text NOT NULL,
  sent_at timestamp with time zone DEFAULT now() NOT NULL,
  responded_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_survey_invitations_token') THEN
    ALTER TABLE public.hrm_survey_invitations
      ADD CONSTRAINT hrm_survey_invitations_token CHECK (char_length(btrim(token_hash)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_survey_invitations_survey_fkey') THEN
    ALTER TABLE public.hrm_survey_invitations
      ADD CONSTRAINT hrm_survey_invitations_survey_fkey FOREIGN KEY (survey_id) REFERENCES public.hrm_surveys (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hrm_survey_invitations_token_unique
  ON public.hrm_survey_invitations (token_hash);
-- One invitation per respondent: re-opening converges instead of
-- double-inviting (the service names this arbiter explicitly, so a token
-- collision can never silently drop a respondent).
CREATE UNIQUE INDEX IF NOT EXISTS hrm_survey_invitations_survey_party
  ON public.hrm_survey_invitations (org_id, survey_id, party_id);
CREATE INDEX IF NOT EXISTS hrm_survey_invitations_survey
  ON public.hrm_survey_invitations (org_id, survey_id);
CREATE INDEX IF NOT EXISTS hrm_survey_invitations_party
  ON public.hrm_survey_invitations (org_id, party_id);

-- (11) Survey responses (one row per submission; link null for anonymous).
CREATE TABLE IF NOT EXISTS public.hrm_survey_responses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  survey_id uuid NOT NULL,
  submitted_at timestamp with time zone DEFAULT now() NOT NULL,
  respondent_link_enc bytea,
  segment_snapshot jsonb,
  answers jsonb NOT NULL DEFAULT '[]'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_survey_responses_survey_fkey') THEN
    ALTER TABLE public.hrm_survey_responses
      ADD CONSTRAINT hrm_survey_responses_survey_fkey FOREIGN KEY (survey_id) REFERENCES public.hrm_surveys (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hrm_survey_responses_survey
  ON public.hrm_survey_responses (org_id, survey_id, submitted_at);

-- Append-only evidence guards (the 0221 evidence rule): events and
-- retention actions are ledgers — updates refused on every path, deletes
-- only on the governed amend path. Record a new row instead of editing.
CREATE OR REPLACE FUNCTION public.hrm_documents_history_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
DECLARE
  changed text[];
BEGIN
  -- Retention actions close exactly once: an open row (executed_at null)
  -- may set executed_at/executed_by (the execution) or blocked_reason
  -- (the legal-hold block). An executed row is history — like the 0226
  -- run log, which closes queued/running runs but never edits terminal
  -- ones. Events and responses allow no update at all.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'hrm_retention_actions' THEN
    IF OLD.executed_at IS NOT NULL THEN
      RAISE EXCEPTION 'openbooks:immutable_evidence: an executed retention action is history — record a new action instead of editing %', OLD.id
        USING ERRCODE = '25001';
    END IF;
    changed := ARRAY(
      SELECT key FROM jsonb_each(to_jsonb(NEW)) AS n(key, value)
      WHERE (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value);
    changed := ARRAY(SELECT c FROM unnest(changed) AS c WHERE c NOT IN ('executed_at', 'executed_by', 'blocked_reason'));
    IF cardinality(changed) > 0 THEN
      RAISE EXCEPTION 'openbooks:immutable_evidence: an open retention action closes or blocks — it never edits %', array_to_string(changed, ', ')
        USING ERRCODE = '25001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'openbooks:immutable_evidence: % rows are append-only — record a new row instead of editing one', TG_TABLE_NAME
      USING ERRCODE = '25001';
  END IF;
  IF TG_OP = 'DELETE'
     AND current_setting('openbooks.amend', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'openbooks:immutable_evidence: % rows delete only on the governed amend path', TG_TABLE_NAME
      USING ERRCODE = '25001';
  END IF;
  RETURN OLD;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_document_events_immutable ON public.hrm_document_events;
CREATE TRIGGER hrm_document_events_immutable
  BEFORE UPDATE OR DELETE ON public.hrm_document_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_documents_history_guard();

DROP TRIGGER IF EXISTS hrm_retention_actions_immutable ON public.hrm_retention_actions;
CREATE TRIGGER hrm_retention_actions_immutable
  BEFORE UPDATE OR DELETE ON public.hrm_retention_actions
  FOR EACH ROW EXECUTE FUNCTION public.hrm_documents_history_guard();

DROP TRIGGER IF EXISTS hrm_survey_responses_immutable ON public.hrm_survey_responses;
CREATE TRIGGER hrm_survey_responses_immutable
  BEFORE UPDATE OR DELETE ON public.hrm_survey_responses
  FOR EACH ROW EXECUTE FUNCTION public.hrm_documents_history_guard();

-- Tenant RLS (0195 pattern): ENABLE + FORCE with org_isolation USING + WITH
-- CHECK on all twelve tables.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_document_categories', 'hrm_document_templates', 'hrm_documents',
    'hrm_document_signers', 'hrm_document_events', 'hrm_retention_schedules',
    'hrm_retention_actions', 'hrm_data_subject_exports', 'hrm_surveys',
    'hrm_survey_questions', 'hrm_survey_invitations',
    'hrm_survey_responses'] LOOP
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

COMMENT ON TABLE public.hrm_document_categories IS
  'HRM document categories (0230): the org-declared Setup vocabulary for template, document, and retention-schedule category keys.';
COMMENT ON TABLE public.hrm_document_templates IS
  'HRM document templates (0230): org-authored shells with mustache bodies and declared merge fields; signatures ordered by signer_roles.';
COMMENT ON TABLE public.hrm_documents IS
  'HRM documents (0230): one row per issued HR document; the file is the current File Cabinet version, retain_until is stored at completion.';
COMMENT ON TABLE public.hrm_document_signers IS
  'HRM document signers (0230): ordered signer rows with one consumable HMAC token each and the signing evidence record.';
COMMENT ON TABLE public.hrm_document_events IS
  'HRM document events (0230): append-only evidence ledger for every document transition.';
COMMENT ON TABLE public.hrm_retention_schedules IS
  'HRM retention schedules (0230): one active rule per org category — years counted from completion, termination, or creation.';
COMMENT ON TABLE public.hrm_retention_actions IS
  'HRM retention actions (0230): append-only ledger of flagged and executed deletions/anonymizations.';
COMMENT ON TABLE public.hrm_data_subject_exports IS
  'HRM subject-access exports (0230): the DSAR queue; the worker builds the zip into the File Cabinet for the requester only.';
COMMENT ON TABLE public.hrm_surveys IS
  'HRM surveys (0230): engagement, pulse, onboarding, exit, custom — with the anonymity grade that decides what a response may store.';
COMMENT ON TABLE public.hrm_survey_questions IS
  'HRM survey questions (0230): ordered question cards with the driver vocabulary heatmaps group by.';
COMMENT ON TABLE public.hrm_survey_invitations IS
  'HRM survey invitations (0230): one consumable token per respondent; anonymous invitations record only that a response happened.';
COMMENT ON TABLE public.hrm_survey_responses IS
  'HRM survey responses (0230): one row per submission; respondent_link_enc stays null for anonymous surveys and segments below minimum are null.';
