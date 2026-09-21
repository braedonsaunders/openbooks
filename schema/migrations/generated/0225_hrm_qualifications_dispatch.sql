-- OpenBooks forward migration 0225_hrm_qualifications_dispatch.
--
-- HR-14 certifications, licenses and dispatch gating: the worker
-- qualification ledger, requirements on projects and equipment, expiry
-- alerts, and the read model behind the resource board's refusal.
--
-- The question this answers: can this person be on that job today?
-- Subcontractor compliance answers it for vendors (COIs, lien waivers);
-- nothing answers it for our own workers. This is the HR side.
--
-- Tables (all org-scoped, all under the org_isolation RLS below):
--   hrm_qualification_types       the org's qualification taxonomy (codes
--                               the org declares through Setup). category
--                               is org-extensible text: the six base values
--                               plus the org's own list in
--                               hrm_qualification_settings, enforced by the
--                               category-guard trigger below (a static CHECK
--                               could not admit org-declared values).
--                               validity_months null = does not expire.
--   hrm_worker_qualifications     one held qualification per employment
--                               record (NOT party: qualifications belong to
--                               the employment and survive a rehire as
--                               history). expires_on is STORED (defaulted
--                               from validity_months at save), never
--                               computed at read. Stored status is only
--                               valid | revoked | pending_verification:
--                               expiring/expired are DERIVED at read from
--                               expires_on and the type's lead days — the
--                               read service projects them, storage never
--                               holds derived state.
--   hrm_qualification_events      append-only evidence (recorded, verified,
--                               renewed, revoked, expired_noticed,
--                               alert_sent, warned). Updates refused on
--                               every path; deletes only on the governed
--                               amend path. renew links the new row to the
--                               old one in related_qualification_id — a
--                               renewal is a NEW row, never an overwrite.
--                               warned records a warn-severity dispatch that
--                               proceeded anyway, against the qualification.
--   hrm_qualification_requirements what a subject demands: subject_kind in
--                               project, equipment, position,
--                               classification; subject_id is polymorphic
--                               (no FK — one column names four parents);
--                               severity block refuses the assignment by
--                               name, warn lets it through and records a
--                               warned event for display.
--   hrm_qualification_alerts      one row per (qualification, lead_days):
--                               populated idempotently by the daily alert
--                               scan, consumed by the inbox; sent_at null =
--                               due but not yet delivered.
--   hrm_qualification_settings    the org's extended category vocabulary
--                               plus the default alert lead-day schedule
--                               (30/14/7/1 unless a type overrides it).
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
-- (1) Qualification types: the org-declared taxonomy.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_qualification_types (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  issuing_body text,
  validity_months integer,
  renewal_lead_days integer NOT NULL DEFAULT 30,
  requires_evidence boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_qualification_types_code
    CHECK (char_length(btrim(code)) > 0),
  CONSTRAINT hrm_qualification_types_name
    CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT hrm_qualification_types_category
    CHECK (char_length(btrim(category)) > 0),
  CONSTRAINT hrm_qualification_types_validity
    CHECK (validity_months IS NULL OR validity_months > 0),
  CONSTRAINT hrm_qualification_types_lead_days
    CHECK (renewal_lead_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_qualification_types_org_id_id_unique
  ON public.hrm_qualification_types (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_qualification_types_org_code_unique
  ON public.hrm_qualification_types (org_id, code);

-- ---------------------------------------------------------------------------
-- (2) Worker qualifications: held credentials per employment record.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_worker_qualifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  type_id uuid NOT NULL,
  identifier text,
  issued_on date NOT NULL,
  expires_on date,
  status text NOT NULL DEFAULT 'pending_verification',
  evidence_file_id uuid,
  verified_by uuid,
  verified_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_worker_qualifications_status
    CHECK (status IN ('valid', 'revoked', 'pending_verification')),
  CONSTRAINT hrm_worker_qualifications_window
    CHECK (expires_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT hrm_worker_qualifications_verified_pair
    CHECK ((verified_at IS NULL AND verified_by IS NULL)
        OR (verified_at IS NOT NULL AND verified_by IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_worker_qualifications_org_id_id_unique
  ON public.hrm_worker_qualifications (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_worker_qualifications_org_employment_type_issued_unique
  ON public.hrm_worker_qualifications (org_id, employment_id, type_id, issued_on);
CREATE INDEX IF NOT EXISTS hrm_worker_qualifications_org_employment
  ON public.hrm_worker_qualifications (org_id, employment_id);
CREATE INDEX IF NOT EXISTS hrm_worker_qualifications_org_expiry
  ON public.hrm_worker_qualifications (org_id, expires_on)
  WHERE status <> 'revoked';

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_worker_qualifications_employment_fkey') THEN
  ALTER TABLE ONLY public.hrm_worker_qualifications
    ADD CONSTRAINT hrm_worker_qualifications_employment_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_worker_qualifications_type_fkey') THEN
  ALTER TABLE ONLY public.hrm_worker_qualifications
    ADD CONSTRAINT hrm_worker_qualifications_type_fkey
    FOREIGN KEY (org_id, type_id) REFERENCES public.hrm_qualification_types (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_worker_qualifications_evidence_fkey') THEN
  ALTER TABLE ONLY public.hrm_worker_qualifications
    ADD CONSTRAINT hrm_worker_qualifications_evidence_fkey
    FOREIGN KEY (org_id, evidence_file_id) REFERENCES public.files (org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- (3) Qualification events: append-only evidence ledger.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_qualification_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  qualification_id uuid NOT NULL,
  related_qualification_id uuid,
  kind text NOT NULL,
  actor_id uuid,
  reason text,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT hrm_qualification_events_kind
    CHECK (kind IN ('recorded', 'verified', 'renewed', 'revoked',
                    'expired_noticed', 'alert_sent', 'warned')),
  CONSTRAINT hrm_qualification_events_reason
    CHECK (reason IS NULL OR char_length(btrim(reason)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_qualification_events_org_id_id_unique
  ON public.hrm_qualification_events (org_id, id);
CREATE INDEX IF NOT EXISTS hrm_qualification_events_org_qualification
  ON public.hrm_qualification_events (org_id, qualification_id, recorded_at);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_qualification_events_qualification_fkey') THEN
  ALTER TABLE ONLY public.hrm_qualification_events
    ADD CONSTRAINT hrm_qualification_events_qualification_fkey
    FOREIGN KEY (org_id, qualification_id) REFERENCES public.hrm_worker_qualifications (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_qualification_events_related_fkey') THEN
  ALTER TABLE ONLY public.hrm_qualification_events
    ADD CONSTRAINT hrm_qualification_events_related_fkey
    FOREIGN KEY (org_id, related_qualification_id) REFERENCES public.hrm_worker_qualifications (org_id, id); END IF; END $$;

CREATE OR REPLACE FUNCTION public.hrm_qualification_events_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  RAISE EXCEPTION
    'HRM qualification event % is append-only audit evidence — record a new event instead of rewriting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_qualification_events_no_update_trigger ON public.hrm_qualification_events;
CREATE TRIGGER hrm_qualification_events_no_update_trigger
  BEFORE UPDATE ON public.hrm_qualification_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_qualification_events_no_rewrite();

CREATE OR REPLACE FUNCTION public.hrm_qualification_events_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM qualification event % is append-only audit evidence — it can only be removed on the governed amend path.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_qualification_events_no_delete_trigger ON public.hrm_qualification_events;
CREATE TRIGGER hrm_qualification_events_no_delete_trigger
  BEFORE DELETE ON public.hrm_qualification_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_qualification_events_no_delete();

-- ---------------------------------------------------------------------------
-- (4) Requirements: what a project, equipment, position or classification
-- demands. subject_id is polymorphic (no FK — one column names four
-- parents); the service checks the caller can read the subject.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_qualification_requirements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  type_id uuid NOT NULL,
  required_from date NOT NULL DEFAULT CURRENT_DATE,
  required_to date,
  severity text NOT NULL DEFAULT 'block',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_qualification_requirements_subject_kind
    CHECK (subject_kind IN ('project', 'equipment', 'position', 'classification')),
  CONSTRAINT hrm_qualification_requirements_severity
    CHECK (severity IN ('block', 'warn')),
  CONSTRAINT hrm_qualification_requirements_window
    CHECK (required_to IS NULL OR required_to >= required_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_qualification_requirements_org_id_id_unique
  ON public.hrm_qualification_requirements (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_qualification_requirements_org_subject_type_unique
  ON public.hrm_qualification_requirements (org_id, subject_kind, subject_id, type_id);
CREATE INDEX IF NOT EXISTS hrm_qualification_requirements_org_subject
  ON public.hrm_qualification_requirements (org_id, subject_kind, subject_id);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_qualification_requirements_type_fkey') THEN
  ALTER TABLE ONLY public.hrm_qualification_requirements
    ADD CONSTRAINT hrm_qualification_requirements_type_fkey
    FOREIGN KEY (org_id, type_id) REFERENCES public.hrm_qualification_types (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (5) Alerts: one row per (qualification, lead_days), written idempotently
-- by the daily scan and consumed by the inbox.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_qualification_alerts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  qualification_id uuid NOT NULL,
  lead_days integer NOT NULL,
  due_on date NOT NULL,
  sent_at timestamp with time zone,
  channel text NOT NULL DEFAULT 'inbox',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT hrm_qualification_alerts_lead_days
    CHECK (lead_days > 0),
  CONSTRAINT hrm_qualification_alerts_channel
    CHECK (channel IN ('inbox', 'email'))
);

CREATE UNIQUE INDEX IF NOT EXISTS hrm_qualification_alerts_org_id_id_unique
  ON public.hrm_qualification_alerts (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hrm_qualification_alerts_qualification_lead_unique
  ON public.hrm_qualification_alerts (qualification_id, lead_days);
CREATE INDEX IF NOT EXISTS hrm_qualification_alerts_org_due
  ON public.hrm_qualification_alerts (org_id, due_on)
  WHERE sent_at IS NULL;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_qualification_alerts_qualification_fkey') THEN
  ALTER TABLE ONLY public.hrm_qualification_alerts
    ADD CONSTRAINT hrm_qualification_alerts_qualification_fkey
    FOREIGN KEY (org_id, qualification_id) REFERENCES public.hrm_worker_qualifications (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- (6) Settings: the org's extended category vocabulary and default alert
-- schedule. The category-guard trigger below reads this row: a category
-- the org has not declared (in the six base values or here) is refused
-- BY NAME with the Setup path as the remedy.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_qualification_settings (
  org_id uuid PRIMARY KEY,
  extra_categories text[] NOT NULL DEFAULT '{}',
  alert_lead_days integer[] NOT NULL DEFAULT '{30,14,7,1}',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  -- Blank category entries and non-positive lead days are refused by the
  -- service (declareCategory / setAlertSchedule): CHECK constraints
  -- cannot use subqueries, so storage pins only the non-empty schedule
  -- and the trigger below reads the vocabulary verbatim.
  CONSTRAINT hrm_qualification_settings_lead_days
    CHECK (array_length(alert_lead_days, 1) IS NOT NULL)
);

CREATE OR REPLACE FUNCTION public.hrm_qualification_types_category_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
DECLARE
  extra text[];
BEGIN
  SELECT coalesce(s.extra_categories, '{}') INTO extra
    FROM public.hrm_qualification_settings s
   WHERE s.org_id = NEW.org_id;
  IF NEW.category NOT IN ('certification', 'license', 'training',
                          'medical', 'clearance', 'other')
     AND NOT (NEW.category = ANY (coalesce(extra, '{}'))) THEN
    RAISE EXCEPTION
      'Qualification category "%" is not declared for this organization — declare it under Company Settings → Features → Qualifications (extra categories) or use one of certification, license, training, medical, clearance, other.', NEW.category;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_qualification_types_category_trigger ON public.hrm_qualification_types;
CREATE TRIGGER hrm_qualification_types_category_trigger
  BEFORE INSERT OR UPDATE OF category ON public.hrm_qualification_types
  FOR EACH ROW EXECUTE FUNCTION public.hrm_qualification_types_category_guard();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0184/0185 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all six tables.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_qualification_types', 'hrm_worker_qualifications',
    'hrm_qualification_events', 'hrm_qualification_requirements',
    'hrm_qualification_alerts', 'hrm_qualification_settings'] LOOP
    IF to_regclass(format('public.%I', tbl)) IS NULL THEN
      CONTINUE;
    END IF;
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

COMMENT ON TABLE public.hrm_qualification_types IS
  'HRM qualification taxonomy (0225): org-declared codes through Setup. category is base-six plus the org extra list in hrm_qualification_settings (trigger-guarded); validity_months null never expires.';
COMMENT ON TABLE public.hrm_worker_qualifications IS
  'HRM held qualifications (0225): one row per employment record (history survives rehire). expires_on is STORED at save; status stores only valid | revoked | pending_verification — expiring/expired are derived at read.';
COMMENT ON TABLE public.hrm_qualification_events IS
  'HRM qualification evidence (0225): append-only; renewals link the new row to the old one, warned records a warn-severity dispatch that proceeded.';
COMMENT ON TABLE public.hrm_qualification_requirements IS
  'HRM dispatch requirements (0225): what a project, equipment, position or classification demands. block refuses the assignment by name; warn records a warned event.';
COMMENT ON TABLE public.hrm_qualification_alerts IS
  'HRM qualification alerts (0225): one row per (qualification, lead_days), written idempotently by the daily scan; sent_at null is due but undelivered.';
COMMENT ON TABLE public.hrm_qualification_settings IS
  'HRM qualification settings (0225): the org extended category vocabulary and default alert lead-day schedule.';
