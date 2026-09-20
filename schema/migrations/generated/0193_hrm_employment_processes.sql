-- OpenBooks forward migration 0193_hrm_employment_processes.
--
-- Onboarding, offboarding, and transfer checklists (HR-4). Every employment
-- start, end, and transfer drives a checklist with owners, due dates, and
-- evidence; completion is a recorded fact, not a memory.
--
-- CONFIGURATION (Setup registry, deactivation preserves history):
--   hrm_process_templates: one row per (kind, name) with an applies_to
--     filter ({employer_subsidiary_id, department_id} as uuid text or null;
--     absent/null = all). Shape-pinned null-safe like 0184: every nullable
--     participant gets an explicit presence/type conjunct. Filter targets
--     are proven by the service (unknown subsidiary/department refused at
--     save — a template that can never apply is not saved as applicable).
--   hrm_process_template_steps: ordered rows (unique position per
--     template); owner_party_id is set exactly when owner_kind is
--     named_party (two-valued CHECK); due_offset_days is relative to the
--     process effective date and may be negative.
--
-- HISTORY (snapshot, never rewritten):
--   hrm_processes / hrm_process_steps: a process is instantiated from its
--     template as a SNAPSHOT (steps copied), so later template edits never
--     rewrite history. Opened automatically inside the SAME transaction that
--     applies the approved change request (hire → onboarding, termination →
--     offboarding, employer/department change → transfer), evidenced by
--     opened_by_change_id, or manually through the service. At most one OPEN
--     process of a kind per employment: a partial unique index (concurrent
--     openers serialize instead of duplicating — a BEFORE trigger would go
--     blind under READ COMMITTED, per the 0184 rule).
--   Terminal rows are immutable except a pure audit touch (mirrors the 0184
--     closure guards); deletes admitted only on the governed amend path
--     (openbooks.amend, fixture teardown / org wipe — the 0184/0188 house
--     mechanism, never a production path). Deleting a template that opened
--     processes is refused by name (deactivate with is_active instead);
--     template steps cascade with their template, and template_step_id on
--     runtime steps is LINEAGE (single-column SET NULL: it proves which row
--     was copied, never scope — the snapshot columns are the record).
--   attachment_id names a files row in the same org (composite tenant FK,
--     0044 pattern — requires the covering UNIQUE(org_id, id) added below;
--     files.id is the PK so the uniqueness already holds, this only names
--     it). RESTRICT so evidence never loses its file. done_by is frozen
--     evidence actors like 0185 submitted_by (users(id) RESTRICT, no
--     same-org assertion — home-org users — and therefore never nulled).
--
-- HRM stays out of the generic governed-query catalog: no
-- openbooks_refresh_query_catalog call in this migration.

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

CREATE TABLE IF NOT EXISTS public.hrm_process_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_process_templates_kind
      CHECK (kind IN ('onboarding', 'offboarding', 'transfer')),
    CONSTRAINT hrm_process_templates_name
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_process_templates_applies_shape
      CHECK (jsonb_typeof(applies_to) = 'object'
        AND (applies_to - 'employer_subsidiary_id' - 'department_id') = '{}'::jsonb
        AND (NOT (applies_to ? 'employer_subsidiary_id')
             OR jsonb_typeof(applies_to -> 'employer_subsidiary_id') = 'null'
             OR (jsonb_typeof(applies_to -> 'employer_subsidiary_id') = 'string'
                 AND applies_to ->> 'employer_subsidiary_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
        AND (NOT (applies_to ? 'department_id')
             OR jsonb_typeof(applies_to -> 'department_id') = 'null'
             OR (jsonb_typeof(applies_to -> 'department_id') = 'string'
                 AND applies_to ->> 'department_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')))
);

CREATE TABLE IF NOT EXISTS public.hrm_process_template_steps (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    position integer NOT NULL,
    title text NOT NULL,
    description text,
    owner_kind text NOT NULL,
    owner_party_id uuid,
    due_offset_days integer NOT NULL DEFAULT 0,
    required boolean NOT NULL DEFAULT true,
    evidence_kind text NOT NULL DEFAULT 'none',
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_process_template_steps_owner
      CHECK (owner_kind IN ('manager', 'hr', 'employee', 'named_party')),
    CONSTRAINT hrm_process_template_steps_owner_party
      CHECK ((owner_kind = 'named_party') = (owner_party_id IS NOT NULL)),
    CONSTRAINT hrm_process_template_steps_title
      CHECK (char_length(btrim(title)) > 0),
    CONSTRAINT hrm_process_template_steps_position
      CHECK (position >= 0),
    CONSTRAINT hrm_process_template_steps_evidence
      CHECK (evidence_kind IN ('none', 'acknowledgement', 'attachment'))
);

CREATE TABLE IF NOT EXISTS public.hrm_processes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    kind text NOT NULL,
    effective_date date NOT NULL,
    status text NOT NULL DEFAULT 'open',
    opened_by_change_id uuid,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_processes_kind
      CHECK (kind IN ('onboarding', 'offboarding', 'transfer')),
    CONSTRAINT hrm_processes_status
      CHECK (status IN ('open', 'completed', 'cancelled')),
    CONSTRAINT hrm_processes_completed_paired
      CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CONSTRAINT hrm_processes_cancelled_paired
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
    CONSTRAINT hrm_processes_cancel_reason
      CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL AND char_length(btrim(cancel_reason)) > 0)),
    CONSTRAINT hrm_processes_finite_time CHECK (
      effective_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (completed_at IS NULL
           OR (completed_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND completed_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
      AND (cancelled_at IS NULL
           OR (cancelled_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND cancelled_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

CREATE TABLE IF NOT EXISTS public.hrm_process_steps (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    process_id uuid NOT NULL,
    template_step_id uuid,
    position integer NOT NULL,
    title text NOT NULL,
    description text,
    owner_kind text NOT NULL,
    owner_party_id uuid,
    due_on date NOT NULL,
    required boolean NOT NULL DEFAULT true,
    evidence_kind text NOT NULL DEFAULT 'none',
    status text NOT NULL DEFAULT 'pending',
    done_by uuid,
    done_at timestamp with time zone,
    skip_reason text,
    attachment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_process_steps_owner
      CHECK (owner_kind IN ('manager', 'hr', 'employee', 'named_party')),
    CONSTRAINT hrm_process_steps_owner_party
      CHECK ((owner_kind = 'named_party') = (owner_party_id IS NOT NULL)),
    CONSTRAINT hrm_process_steps_title
      CHECK (char_length(btrim(title)) > 0),
    CONSTRAINT hrm_process_steps_position
      CHECK (position >= 0),
    CONSTRAINT hrm_process_steps_evidence
      CHECK (evidence_kind IN ('none', 'acknowledgement', 'attachment')),
    CONSTRAINT hrm_process_steps_status
      CHECK (status IN ('pending', 'done', 'skipped')),
    CONSTRAINT hrm_process_steps_done_paired
      CHECK ((status = 'done') = (done_at IS NOT NULL)
         AND (status = 'done') = (done_by IS NOT NULL)),
    CONSTRAINT hrm_process_steps_skip_reason
      CHECK ((status = 'skipped') = (skip_reason IS NOT NULL AND char_length(btrim(skip_reason)) > 0)),
    CONSTRAINT hrm_process_steps_attachment_scope
      CHECK (attachment_id IS NULL OR evidence_kind = 'attachment'),
    CONSTRAINT hrm_process_steps_finite_time CHECK (
      due_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (done_at IS NULL
           OR (done_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND done_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

-- ---------------------------------------------------------------------------
-- Covering uniques, keys, indexes. All added defensively (re-runnable).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_templates_pkey') THEN
  ALTER TABLE ONLY public.hrm_process_templates ADD CONSTRAINT hrm_process_templates_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_template_steps_pkey') THEN
  ALTER TABLE ONLY public.hrm_process_template_steps ADD CONSTRAINT hrm_process_template_steps_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_pkey') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_pkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_pkey PRIMARY KEY (id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_templates_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_process_templates ADD CONSTRAINT hrm_process_templates_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_template_steps_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_process_template_steps ADD CONSTRAINT hrm_process_template_steps_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_templates_org_kind_name') THEN
  ALTER TABLE ONLY public.hrm_process_templates ADD CONSTRAINT hrm_process_templates_org_kind_name
    UNIQUE (org_id, kind, name); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_template_steps_org_template_position') THEN
  ALTER TABLE ONLY public.hrm_process_template_steps ADD CONSTRAINT hrm_process_template_steps_org_template_position
    UNIQUE (org_id, template_id, position); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_org_process_position') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_org_process_position
    UNIQUE (org_id, process_id, position); END IF; END $$;

-- One OPEN process of a kind per employment (partial unique: completed and
-- cancelled rows never conflict, so history accumulates while the open
-- invariant holds race-safe under concurrent writers).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_open_one_per_kind') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_open_one_per_kind
    UNIQUE (org_id, employment_id, kind) WHERE status = 'open'; END IF; END $$;

-- Covering unique for the composite attachment FK below. files.id is the
-- primary key so (org_id, id) uniqueness already holds; this only names it
-- (0044 composite-org-coherence pattern, no single-column FK + trigger).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_org_id_id_unique') THEN
  ALTER TABLE ONLY public.files ADD CONSTRAINT files_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

CREATE INDEX IF NOT EXISTS hrm_process_templates_org_kind
  ON public.hrm_process_templates USING btree (org_id, kind, is_active);
CREATE INDEX IF NOT EXISTS hrm_process_template_steps_template
  ON public.hrm_process_template_steps USING btree (org_id, template_id, position);
CREATE INDEX IF NOT EXISTS hrm_processes_employment
  ON public.hrm_processes USING btree (org_id, employment_id, kind, status);
CREATE INDEX IF NOT EXISTS hrm_processes_status
  ON public.hrm_processes USING btree (org_id, status);
CREATE INDEX IF NOT EXISTS hrm_process_steps_process
  ON public.hrm_process_steps USING btree (org_id, process_id, position);
CREATE INDEX IF NOT EXISTS hrm_process_steps_overdue
  ON public.hrm_process_steps USING btree (org_id, status, due_on);

-- ---------------------------------------------------------------------------
-- Tenant foreign keys (composite org coherence, 0044 pattern). No ON DELETE
-- CASCADE on runtime history: processes pin their template (RESTRICT) and
-- steps follow their process (CASCADE, children of a guarded parent).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_templates_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_templates ADD CONSTRAINT hrm_process_templates_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_template_steps_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_template_steps ADD CONSTRAINT hrm_process_template_steps_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_template_steps_template_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_template_steps ADD CONSTRAINT hrm_process_template_steps_template_tenant_fkey
    FOREIGN KEY (org_id, template_id) REFERENCES public.hrm_process_templates(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_template_steps_owner_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_template_steps ADD CONSTRAINT hrm_process_template_steps_owner_tenant_fkey
    FOREIGN KEY (org_id, owner_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_template_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_template_tenant_fkey
    FOREIGN KEY (org_id, template_id) REFERENCES public.hrm_process_templates(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_opened_change_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_opened_change_tenant_fkey
    FOREIGN KEY (org_id, opened_by_change_id) REFERENCES public.employment_changes(org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_process_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_process_tenant_fkey
    FOREIGN KEY (org_id, process_id) REFERENCES public.hrm_processes(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_owner_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_owner_tenant_fkey
    FOREIGN KEY (org_id, owner_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;
-- Lineage to the copied template step: single-column SET NULL (lineage, not
-- scope — the snapshot columns are the record; same-org is proven at copy
-- time by the opening service, so a cross-org pointer cannot be written).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_template_step_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_template_step_fkey
    FOREIGN KEY (template_step_id) REFERENCES public.hrm_process_template_steps(id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_attachment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_attachment_tenant_fkey
    FOREIGN KEY (org_id, attachment_id) REFERENCES public.files(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

-- Frozen evidence actors (0185 pattern): single-column RESTRICT with no
-- same-org assertion (home-org users), and therefore never nulled — nulling
-- done_by on user delete would silently rewrite who completed the step.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_done_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_done_by_fkey
    FOREIGN KEY (done_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_templates_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_templates ADD CONSTRAINT hrm_process_templates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_templates_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_templates ADD CONSTRAINT hrm_process_templates_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_template_steps_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_template_steps ADD CONSTRAINT hrm_process_template_steps_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_template_steps_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_template_steps ADD CONSTRAINT hrm_process_template_steps_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_processes_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_processes ADD CONSTRAINT hrm_processes_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_process_steps_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_process_steps ADD CONSTRAINT hrm_process_steps_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Storage triggers.
-- ---------------------------------------------------------------------------

-- A template that opened processes is history-pinned: deactivate it with
-- is_active = false instead of deleting it. The RESTRICT FK below is the
-- backstop; this trigger names the remedy (a raw 23503 names nothing).
CREATE OR REPLACE FUNCTION public.hrm_process_template_no_delete()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE live_count integer;
BEGIN
  SELECT count(*)::int INTO live_count FROM public.hrm_processes
   WHERE org_id = OLD.org_id AND template_id = OLD.id;
  IF live_count > 0 THEN
    RAISE EXCEPTION 'HRM process template % opened % process(es) and is retained as history — set is_active = false to retire it instead of deleting it.', OLD.id, live_count
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;

COMMENT ON FUNCTION public.hrm_process_template_no_delete() IS
  'openbooks:hrm_process_template_no_delete:v1 - a template with processes is history-pinned; the BEFORE DELETE trigger names the deactivation remedy before the RESTRICT FK fires';

DROP TRIGGER IF EXISTS hrm_process_template_no_delete ON public.hrm_process_templates;
CREATE TRIGGER hrm_process_template_no_delete
  BEFORE DELETE ON public.hrm_process_templates
  FOR EACH ROW EXECUTE FUNCTION public.hrm_process_template_no_delete();

-- Runtime history is never deleted on a production path (0184/0188 house
-- mechanism): terminal rows are immutable except a pure audit touch; deletes
-- admitted only when openbooks.amend = on (fixture teardown, org wipe).
CREATE OR REPLACE FUNCTION public.hrm_processes_history_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hrm_processes: processes are retained as history — cancel with a reason instead of deleting them'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('completed', 'cancelled')
     AND to_jsonb(NEW) - ARRAY['updated_at','updated_by']
       <> to_jsonb(OLD) - ARRAY['updated_at','updated_by'] THEN
    RAISE EXCEPTION 'hrm_processes: a % process is terminal and immutable — open a new process for further work', OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.hrm_processes_history_guard() IS
  'openbooks:hrm_processes_history_guard:v1 - terminal processes immutable except a pure audit touch; deletes only on the governed amend path';

DROP TRIGGER IF EXISTS hrm_processes_history ON public.hrm_processes;
CREATE TRIGGER hrm_processes_history
  BEFORE UPDATE OR DELETE ON public.hrm_processes
  FOR EACH ROW EXECUTE FUNCTION public.hrm_processes_history_guard();

CREATE OR REPLACE FUNCTION public.hrm_process_steps_history_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hrm_process_steps: checklist steps are retained as history — skip with a reason instead of deleting them'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('done', 'skipped')
     AND to_jsonb(NEW) - ARRAY['updated_at','updated_by']
       <> to_jsonb(OLD) - ARRAY['updated_at','updated_by'] THEN
    RAISE EXCEPTION 'hrm_process_steps: a % step is terminal and immutable — evidence stands as recorded', OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.hrm_process_steps_history_guard() IS
  'openbooks:hrm_process_steps_history_guard:v1 - terminal steps immutable except a pure audit touch; deletes only on the governed amend path';

DROP TRIGGER IF EXISTS hrm_process_steps_history ON public.hrm_process_steps;
CREATE TRIGGER hrm_process_steps_history
  BEFORE UPDATE OR DELETE ON public.hrm_process_steps
  FOR EACH ROW EXECUTE FUNCTION public.hrm_process_steps_history_guard();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0177/0181 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all four tables. HRM stays out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_process_templates', 'hrm_process_template_steps',
    'hrm_processes', 'hrm_process_steps'] LOOP
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

COMMENT ON TABLE public.hrm_process_templates IS
  'HRM process checklist configuration (0193): one ordered checklist per (kind, name) with an applies_to filter (employer subsidiary / department, null = all). Deactivation preserves history; a template that opened processes cannot be deleted.';
COMMENT ON TABLE public.hrm_process_template_steps IS
  'HRM process checklist rows (0193): ordered steps with owner, due offset relative to the process effective date (may be negative), and evidence kind. Copied as a snapshot when a process opens; later edits never rewrite history.';
COMMENT ON TABLE public.hrm_processes IS
  'HRM runtime checklists (0193): one row per employment start, end, or transfer, opened in the same transaction as the approved change request (opened_by_change_id) or manually. At most one open process of a kind per employment; terminal rows immutable; deletes only on the governed amend path.';
COMMENT ON TABLE public.hrm_process_steps IS
  'HRM runtime checklist rows (0193): snapshot copies of the template steps with concrete due dates. Done steps carry who/when evidence; skipped steps carry a reason; attachment evidence names a same-org file the actor may read.';
