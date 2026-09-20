-- OpenBooks forward migration 0196_hrm_performance_retention.
--
-- HR-7 performance reviews, goals, and retention. Employment records,
-- positions and checklists exist; nothing records how people are doing or
-- why they leave. Reviews are a cycle the org runs (templates, self and
-- manager assessments, calibration, sharing, acknowledgement) with the
-- privacy model built in from the first row: a review is visible to its
-- subject only when shared, to the manager through reporting_relationships,
-- and to HR through the grant. Retention is the exit record and the
-- attrition figures derived from what the employment history already knows.
--
-- Tables (all org-scoped, all under the org_isolation RLS below):
--   hrm_review_templates / hrm_review_template_sections /
--     hrm_review_template_questions — CONFIGURATION: the review form per
--     org (name, rating scale {min,max,labels[]}, sections in
--     competency/goals/free_text kinds, prompts with rating/text/
--     rating_and_text answer kinds). Editable through the Setup registry;
--     deactivation (is_active) preserves history, never deletes it. The
--     scale shape CHECK is the single authority on scale content.
--   hrm_review_cycles — a review run over a period (draft, open,
--     calibrating, closed) with the same applies_to
--     {employer_subsidiary_id, department_id} shape CHECK as
--     hrm_process_templates. Cycles are created through the service, never
--     the Setup drawer, so NO STORED GENERATED slot projections exist here
--     by design: structured surfaces read cycles through the performance
--     read service, and the sandbox clone remaps applies_to through
--     remapScopeFilter (hrm_review_cycles is registered in
--     SCOPE_FILTER_TABLES). manager_gap_count records how many in-scope
--     employments had no resolvable manager at open time.
--   hrm_reviews — one assessment per (cycle, employment, kind, reviewer)
--     in pending/submitted/calibrated/shared/acknowledged. Calibration
--     never overwrites: calibrated_rating sits beside the original
--     overall_rating with its reason.
--   hrm_review_answers — the template snapshot: sections/questions copied
--     into answer rows at instantiation so a later template edit never
--     rewrites an open cycle.
--   hrm_review_events — append-only lifecycle evidence (instantiated,
--     submitted, calibrated, shared, acknowledged, reopened) with the
--     refuse-update trigger below.
--   hrm_goals — per-employment intentions (title, due date, weight,
--     active/achieved/missed/cancelled, progress 0..100) optionally owned
--     by a cycle; hrm_goal_updates is their append-only progress evidence.
--   hrm_exit_records — the exit record for a terminated employment, one
--     per employment: reason kind, voluntary/involuntary, regrettable and
--     rehire flags, the exit interview (held date paired with interviewer),
--     destination and notes.
--
-- Privacy is a SERVICE property (the performance read service scopes every
-- read by grant, subject identity, and reporting line), never a storage
-- one: RLS below is tenant isolation only, exactly like 0192/0193/0194.
--
-- Deletes: submitted-or-later reviews, review events, goal updates and exit
-- records are retained history. Pure-draft cycles and pending reviews may
-- be discarded. The governed amend path (openbooks.amend = on: fixture
-- teardown, sandbox wipe, org purge) is honoured so a review row can never
-- pin its organisation; production paths never set that GUC.
--
-- Additive only. Alters no payroll table, performs no backfill, exposes
-- nothing to the generic governed-query catalog.
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

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hrm_review_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    rating_scale jsonb NOT NULL DEFAULT '{"min": 1, "max": 5, "labels": []}'::jsonb,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_review_templates_name
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_review_templates_scale_shape
      CHECK (jsonb_typeof(rating_scale) = 'object'
        AND (rating_scale ? 'min') AND (rating_scale ? 'max')
        AND jsonb_typeof(rating_scale -> 'min') = 'number'
        AND jsonb_typeof(rating_scale -> 'max') = 'number'
        AND ((rating_scale ->> 'min')::numeric < (rating_scale ->> 'max')::numeric)
        AND ((rating_scale ->> 'max')::numeric - (rating_scale ->> 'min')::numeric) <= 99
        AND (NOT (rating_scale ? 'labels') OR jsonb_typeof(rating_scale -> 'labels') = 'array'))
);

CREATE TABLE IF NOT EXISTS public.hrm_review_template_sections (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    position integer NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    weight numeric(19,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_review_template_sections_kind
      CHECK (kind IN ('competency', 'goals', 'free_text')),
    CONSTRAINT hrm_review_template_sections_title
      CHECK (char_length(btrim(title)) > 0),
    CONSTRAINT hrm_review_template_sections_position
      CHECK (position >= 0),
    CONSTRAINT hrm_review_template_sections_weight
      CHECK (weight IS NULL OR weight >= 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_review_template_questions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    section_id uuid NOT NULL,
    position integer NOT NULL,
    prompt text NOT NULL,
    answer_kind text NOT NULL,
    required boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_review_template_questions_prompt
      CHECK (char_length(btrim(prompt)) > 0),
    CONSTRAINT hrm_review_template_questions_position
      CHECK (position >= 0),
    CONSTRAINT hrm_review_template_questions_answer_kind
      CHECK (answer_kind IN ('rating', 'text', 'rating_and_text'))
);

CREATE TABLE IF NOT EXISTS public.hrm_review_cycles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    name text NOT NULL,
    period_start_on date NOT NULL,
    period_end_on date NOT NULL,
    self_due_on date,
    manager_due_on date,
    status text NOT NULL DEFAULT 'draft',
    applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
    manager_gap_count integer NOT NULL DEFAULT 0,
    opened_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_review_cycles_name
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_review_cycles_status
      CHECK (status IN ('draft', 'open', 'calibrating', 'closed')),
    CONSTRAINT hrm_review_cycles_period
      CHECK (period_end_on >= period_start_on),
    CONSTRAINT hrm_review_cycles_opened_paired
      CHECK ((status IN ('open', 'calibrating', 'closed')) = (opened_at IS NOT NULL)),
    CONSTRAINT hrm_review_cycles_closed_paired
      CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
    CONSTRAINT hrm_review_cycles_gap_count
      CHECK (manager_gap_count >= 0),
    CONSTRAINT hrm_review_cycles_applies_shape
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
    CONSTRAINT hrm_review_cycles_finite_time CHECK (
      period_start_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND period_end_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (self_due_on IS NULL OR self_due_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND (manager_due_on IS NULL OR manager_due_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND (opened_at IS NULL
           OR (opened_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND opened_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
      AND (closed_at IS NULL
           OR (closed_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND closed_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

CREATE TABLE IF NOT EXISTS public.hrm_reviews (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    subject_party_id uuid NOT NULL,
    reviewer_party_id uuid NOT NULL,
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    overall_rating numeric(19,4),
    calibrated_rating numeric(19,4),
    calibration_reason text,
    submitted_at timestamp with time zone,
    shared_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_reviews_kind
      CHECK (kind IN ('self', 'manager', 'peer')),
    CONSTRAINT hrm_reviews_status
      CHECK (status IN ('pending', 'submitted', 'calibrated', 'shared', 'acknowledged')),
    CONSTRAINT hrm_reviews_submitted_paired
      CHECK ((status IN ('submitted', 'calibrated', 'shared', 'acknowledged')) = (submitted_at IS NOT NULL)),
    CONSTRAINT hrm_reviews_shared_paired
      CHECK ((status IN ('shared', 'acknowledged')) = (shared_at IS NOT NULL)),
    CONSTRAINT hrm_reviews_acknowledged_paired
      CHECK ((status = 'acknowledged') = (acknowledged_at IS NOT NULL)),
    CONSTRAINT hrm_reviews_calibrated_paired
      CHECK ((calibrated_rating IS NULL)
             OR (calibration_reason IS NOT NULL AND char_length(btrim(calibration_reason)) > 0)),
    CONSTRAINT hrm_reviews_ratings_non_negative
      CHECK ((overall_rating IS NULL OR overall_rating >= 0)
         AND (calibrated_rating IS NULL OR calibrated_rating >= 0))
);

CREATE TABLE IF NOT EXISTS public.hrm_review_answers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    review_id uuid NOT NULL,
    section_title text NOT NULL,
    question_prompt text,
    position integer NOT NULL,
    answer_kind text NOT NULL,
    rating numeric(19,4),
    text text,
    required boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_review_answers_title
      CHECK (char_length(btrim(section_title)) > 0),
    CONSTRAINT hrm_review_answers_position
      CHECK (position >= 0),
    CONSTRAINT hrm_review_answers_kind
      CHECK (answer_kind IN ('rating', 'text', 'rating_and_text')),
    CONSTRAINT hrm_review_answers_rating
      CHECK (rating IS NULL OR rating >= 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_review_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    review_id uuid NOT NULL,
    kind text NOT NULL,
    actor_user_id uuid,
    reason text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hrm_review_events_kind
      CHECK (kind IN ('instantiated', 'submitted', 'calibrated', 'shared', 'acknowledged', 'reopened'))
);

CREATE TABLE IF NOT EXISTS public.hrm_goals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    due_on date,
    weight numeric(19,4),
    status text NOT NULL DEFAULT 'active',
    progress_percent integer NOT NULL DEFAULT 0,
    cycle_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_goals_title
      CHECK (char_length(btrim(title)) > 0),
    CONSTRAINT hrm_goals_status
      CHECK (status IN ('active', 'achieved', 'missed', 'cancelled')),
    CONSTRAINT hrm_goals_progress
      CHECK (progress_percent >= 0 AND progress_percent <= 100),
    CONSTRAINT hrm_goals_weight
      CHECK (weight IS NULL OR weight >= 0),
    CONSTRAINT hrm_goals_terminal_progress
      CHECK ((status <> 'achieved') OR progress_percent = 100)
);

CREATE TABLE IF NOT EXISTS public.hrm_goal_updates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    goal_id uuid NOT NULL,
    progress_percent integer NOT NULL,
    note text,
    actor_user_id uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hrm_goal_updates_progress
      CHECK (progress_percent >= 0 AND progress_percent <= 100)
);

CREATE TABLE IF NOT EXISTS public.hrm_exit_records (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    termination_change_id uuid,
    reason_kind text NOT NULL,
    is_voluntary boolean NOT NULL,
    is_regrettable boolean,
    would_rehire boolean,
    interview_held_on date,
    interviewer_party_id uuid,
    destination text,
    notes text,
    recorded_by uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_exit_records_reason
      CHECK (reason_kind IN ('resignation', 'retirement', 'end_of_contract', 'dismissal', 'redundancy', 'mutual', 'death', 'other')),
    CONSTRAINT hrm_exit_records_interview_paired
      CHECK ((interview_held_on IS NULL) = (interviewer_party_id IS NULL))
);

-- ---------------------------------------------------------------------------
-- Covering uniques, keys, indexes. All added defensively (re-runnable).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_templates_pkey') THEN
  ALTER TABLE ONLY public.hrm_review_templates ADD CONSTRAINT hrm_review_templates_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_sections_pkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_sections ADD CONSTRAINT hrm_review_template_sections_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_questions_pkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_questions ADD CONSTRAINT hrm_review_template_questions_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_cycles_pkey') THEN
  ALTER TABLE ONLY public.hrm_review_cycles ADD CONSTRAINT hrm_review_cycles_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_pkey') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_answers_pkey') THEN
  ALTER TABLE ONLY public.hrm_review_answers ADD CONSTRAINT hrm_review_answers_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_events_pkey') THEN
  ALTER TABLE ONLY public.hrm_review_events ADD CONSTRAINT hrm_review_events_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goals_pkey') THEN
  ALTER TABLE ONLY public.hrm_goals ADD CONSTRAINT hrm_goals_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goal_updates_pkey') THEN
  ALTER TABLE ONLY public.hrm_goal_updates ADD CONSTRAINT hrm_goal_updates_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_pkey') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_pkey PRIMARY KEY (id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_templates_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_review_templates ADD CONSTRAINT hrm_review_templates_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_sections_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_review_template_sections ADD CONSTRAINT hrm_review_template_sections_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_questions_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_review_template_questions ADD CONSTRAINT hrm_review_template_questions_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_cycles_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_review_cycles ADD CONSTRAINT hrm_review_cycles_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_answers_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_review_answers ADD CONSTRAINT hrm_review_answers_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_events_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_review_events ADD CONSTRAINT hrm_review_events_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goals_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_goals ADD CONSTRAINT hrm_goals_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goal_updates_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_goal_updates ADD CONSTRAINT hrm_goal_updates_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_templates_org_name') THEN
  ALTER TABLE ONLY public.hrm_review_templates ADD CONSTRAINT hrm_review_templates_org_name
    UNIQUE (org_id, name); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_sections_org_template_position') THEN
  ALTER TABLE ONLY public.hrm_review_template_sections ADD CONSTRAINT hrm_review_template_sections_org_template_position
    UNIQUE (org_id, template_id, position); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_questions_org_section_position') THEN
  ALTER TABLE ONLY public.hrm_review_template_questions ADD CONSTRAINT hrm_review_template_questions_org_section_position
    UNIQUE (org_id, section_id, position); END IF; END $$;
-- One review per (cycle, employment, kind, reviewer): concurrent
-- instantiation serializes instead of duplicating.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_org_cycle_employment_kind_reviewer') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_org_cycle_employment_kind_reviewer
    UNIQUE (org_id, cycle_id, employment_id, kind, reviewer_party_id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_answers_org_review_position') THEN
  ALTER TABLE ONLY public.hrm_review_answers ADD CONSTRAINT hrm_review_answers_org_review_position
    UNIQUE (org_id, review_id, position); END IF; END $$;
-- The exit record is one per employment: a second record for the same
-- employment is a correction of the first, made by updating it.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_org_employment_unique') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_org_employment_unique
    UNIQUE (org_id, employment_id); END IF; END $$;

CREATE INDEX IF NOT EXISTS hrm_review_template_sections_template
  ON public.hrm_review_template_sections USING btree (org_id, template_id, position);
CREATE INDEX IF NOT EXISTS hrm_review_template_questions_section
  ON public.hrm_review_template_questions USING btree (org_id, section_id, position);
CREATE INDEX IF NOT EXISTS hrm_review_cycles_status
  ON public.hrm_review_cycles USING btree (org_id, status);
CREATE INDEX IF NOT EXISTS hrm_reviews_cycle
  ON public.hrm_reviews USING btree (org_id, cycle_id, status);
CREATE INDEX IF NOT EXISTS hrm_reviews_subject
  ON public.hrm_reviews USING btree (org_id, subject_party_id, status);
CREATE INDEX IF NOT EXISTS hrm_reviews_employment
  ON public.hrm_reviews USING btree (org_id, employment_id, kind);
CREATE INDEX IF NOT EXISTS hrm_review_answers_review
  ON public.hrm_review_answers USING btree (org_id, review_id, position);
CREATE INDEX IF NOT EXISTS hrm_review_events_review
  ON public.hrm_review_events USING btree (org_id, review_id, recorded_at);
CREATE INDEX IF NOT EXISTS hrm_goals_employment
  ON public.hrm_goals USING btree (org_id, employment_id, status);
CREATE INDEX IF NOT EXISTS hrm_goals_cycle
  ON public.hrm_goals USING btree (org_id, cycle_id);
CREATE INDEX IF NOT EXISTS hrm_goal_updates_goal
  ON public.hrm_goal_updates USING btree (org_id, goal_id, recorded_at);
CREATE INDEX IF NOT EXISTS hrm_exit_records_reason
  ON public.hrm_exit_records USING btree (org_id, reason_kind);

-- ---------------------------------------------------------------------------
-- Tenant foreign keys (composite org coherence, 0044 pattern). No ON DELETE
-- CASCADE on runtime history: cycles pin their template (RESTRICT),
-- reviews/answers/events follow their parents (CASCADE, children of guarded
-- parents), and exit records pin their employment (RESTRICT).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_templates_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_templates ADD CONSTRAINT hrm_review_templates_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_sections_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_sections ADD CONSTRAINT hrm_review_template_sections_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_sections_template_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_sections ADD CONSTRAINT hrm_review_template_sections_template_tenant_fkey
    FOREIGN KEY (org_id, template_id) REFERENCES public.hrm_review_templates(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_questions_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_questions ADD CONSTRAINT hrm_review_template_questions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_questions_section_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_questions ADD CONSTRAINT hrm_review_template_questions_section_tenant_fkey
    FOREIGN KEY (org_id, section_id) REFERENCES public.hrm_review_template_sections(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_cycles_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_cycles ADD CONSTRAINT hrm_review_cycles_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_cycles_template_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_cycles ADD CONSTRAINT hrm_review_cycles_template_tenant_fkey
    FOREIGN KEY (org_id, template_id) REFERENCES public.hrm_review_templates(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_cycle_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_cycle_tenant_fkey
    FOREIGN KEY (org_id, cycle_id) REFERENCES public.hrm_review_cycles(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_subject_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_subject_tenant_fkey
    FOREIGN KEY (org_id, subject_party_id) REFERENCES public.parties(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_reviewer_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_reviewer_tenant_fkey
    FOREIGN KEY (org_id, reviewer_party_id) REFERENCES public.parties(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_answers_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_answers ADD CONSTRAINT hrm_review_answers_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_answers_review_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_answers ADD CONSTRAINT hrm_review_answers_review_tenant_fkey
    FOREIGN KEY (org_id, review_id) REFERENCES public.hrm_reviews(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_events_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_events ADD CONSTRAINT hrm_review_events_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_events_review_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_events ADD CONSTRAINT hrm_review_events_review_tenant_fkey
    FOREIGN KEY (org_id, review_id) REFERENCES public.hrm_reviews(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goals_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_goals ADD CONSTRAINT hrm_goals_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goals_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_goals ADD CONSTRAINT hrm_goals_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goals_cycle_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_goals ADD CONSTRAINT hrm_goals_cycle_tenant_fkey
    FOREIGN KEY (org_id, cycle_id) REFERENCES public.hrm_review_cycles(org_id, id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goal_updates_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_goal_updates ADD CONSTRAINT hrm_goal_updates_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goal_updates_goal_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_goal_updates ADD CONSTRAINT hrm_goal_updates_goal_tenant_fkey
    FOREIGN KEY (org_id, goal_id) REFERENCES public.hrm_goals(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
-- The terminating change is provenance, not scope: single-column SET NULL
-- (the change row may be amended away; the exit record stays).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_change_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_change_fkey
    FOREIGN KEY (termination_change_id) REFERENCES public.employment_changes(id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_interviewer_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_interviewer_tenant_fkey
    FOREIGN KEY (org_id, interviewer_party_id) REFERENCES public.parties(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

-- Frozen evidence actors (0185 pattern): single-column RESTRICT with no
-- same-org assertion (home-org users), and therefore never nulled.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_templates_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_templates ADD CONSTRAINT hrm_review_templates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_templates_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_templates ADD CONSTRAINT hrm_review_templates_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_sections_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_sections ADD CONSTRAINT hrm_review_template_sections_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_sections_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_sections ADD CONSTRAINT hrm_review_template_sections_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_questions_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_questions ADD CONSTRAINT hrm_review_template_questions_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_template_questions_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_template_questions ADD CONSTRAINT hrm_review_template_questions_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_cycles_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_cycles ADD CONSTRAINT hrm_review_cycles_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_cycles_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_cycles ADD CONSTRAINT hrm_review_cycles_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_reviews_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_reviews ADD CONSTRAINT hrm_reviews_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_answers_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_answers ADD CONSTRAINT hrm_review_answers_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_answers_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_answers ADD CONSTRAINT hrm_review_answers_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_review_events_actor_fkey') THEN
  ALTER TABLE ONLY public.hrm_review_events ADD CONSTRAINT hrm_review_events_actor_fkey
    FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goals_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_goals ADD CONSTRAINT hrm_goals_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goals_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_goals ADD CONSTRAINT hrm_goals_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_goal_updates_actor_fkey') THEN
  ALTER TABLE ONLY public.hrm_goal_updates ADD CONSTRAINT hrm_goal_updates_actor_fkey
    FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_recorded_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

-- Review events are append-only evidence: corrections are new rows, never
-- updates. Deletes are admitted only on the governed amend path (fixture
-- teardown, sandbox wipe, org purge); production paths never set that GUC.
CREATE OR REPLACE FUNCTION public.hrm_review_event_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'HRM review event % is append-only evidence — record a new event instead of updating it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_review_event_immutable_trigger ON public.hrm_review_events;
CREATE TRIGGER hrm_review_event_immutable_trigger
  BEFORE UPDATE ON public.hrm_review_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_review_event_immutable_guard();

CREATE OR REPLACE FUNCTION public.hrm_review_event_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM review event % is retained as history and cannot be deleted.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_review_event_no_delete_trigger ON public.hrm_review_events;
CREATE TRIGGER hrm_review_event_no_delete_trigger
  BEFORE DELETE ON public.hrm_review_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_review_event_no_delete();

-- Goal updates are append-only evidence, same contract as review events.
CREATE OR REPLACE FUNCTION public.hrm_goal_update_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'HRM goal update % is append-only evidence — record a new update instead of updating it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_goal_update_immutable_trigger ON public.hrm_goal_updates;
CREATE TRIGGER hrm_goal_update_immutable_trigger
  BEFORE UPDATE ON public.hrm_goal_updates
  FOR EACH ROW EXECUTE FUNCTION public.hrm_goal_update_immutable_guard();

CREATE OR REPLACE FUNCTION public.hrm_goal_update_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM goal update % is retained as history — adjust the goal with a new update instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_goal_update_no_delete_trigger ON public.hrm_goal_updates;
CREATE TRIGGER hrm_goal_update_no_delete_trigger
  BEFORE DELETE ON public.hrm_goal_updates
  FOR EACH ROW EXECUTE FUNCTION public.hrm_goal_update_no_delete();

-- Reviews past pending are retained history; pending reviews may be
-- discarded (a cycle open that instantiated the wrong scope is corrected
-- by deleting its pending reviews, never by editing them). Amend path
-- honoured so a review can never pin its organisation.
CREATE OR REPLACE FUNCTION public.hrm_review_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION
      'HRM review % left pending and is retained as history — reopen it with a reason instead of deleting it.', OLD.id;
  END IF;
  RETURN OLD;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_review_no_delete_trigger ON public.hrm_reviews;
CREATE TRIGGER hrm_review_no_delete_trigger
  BEFORE DELETE ON public.hrm_reviews
  FOR EACH ROW EXECUTE FUNCTION public.hrm_review_no_delete();

-- Exit records are retained history; corrections update the one row per
-- employment, never delete it.
CREATE OR REPLACE FUNCTION public.hrm_exit_record_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM exit record % is retained as history — correct it with an update instead of deleting it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_exit_record_no_delete_trigger ON public.hrm_exit_records;
CREATE TRIGGER hrm_exit_record_no_delete_trigger
  BEFORE DELETE ON public.hrm_exit_records
  FOR EACH ROW EXECUTE FUNCTION public.hrm_exit_record_no_delete();

-- A template that opened cycles is history-pinned: deactivate it with
-- is_active instead of deleting it, so open cycles keep their form.
CREATE OR REPLACE FUNCTION public.hrm_review_template_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.hrm_review_cycles WHERE template_id = OLD.id) THEN
    RAISE EXCEPTION
      'HRM review template % opened review cycles and is history-pinned — set is_active to false instead of deleting it.', OLD.id;
  END IF;
  RETURN OLD;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_review_template_no_delete_trigger ON public.hrm_review_templates;
CREATE TRIGGER hrm_review_template_no_delete_trigger
  BEFORE DELETE ON public.hrm_review_templates
  FOR EACH ROW EXECUTE FUNCTION public.hrm_review_template_no_delete();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0184/0185 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all ten tables. Performance stays out of the
-- generic governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_review_templates', 'hrm_review_template_sections',
    'hrm_review_template_questions', 'hrm_review_cycles',
    'hrm_reviews', 'hrm_review_answers',
    'hrm_review_events', 'hrm_goals',
    'hrm_goal_updates', 'hrm_exit_records'] LOOP
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

COMMENT ON TABLE public.hrm_review_templates IS
  'HRM review form configuration (0196): name, rating scale {min,max,labels[]}, and active flag. Editable through the Setup registry; deactivation preserves history. The scale shape CHECK is the single authority on scale content.';
COMMENT ON TABLE public.hrm_review_template_sections IS
  'HRM ordered review-form sections (0196): competency, goals, or free_text, with an exact-decimal weight.';
COMMENT ON TABLE public.hrm_review_template_questions IS
  'HRM review-form prompts (0196): rating, text, or rating_and_text answers; required prompts must be answered before submit.';
COMMENT ON TABLE public.hrm_review_cycles IS
  'HRM review runs over a period (0196): draft/open/calibrating/closed with the hrm_process_templates applies_to shape. Cycles are created through the service (never the Setup drawer), so no generated slot projections exist by design. manager_gap_count records in-scope employments with no resolvable manager at open time.';
COMMENT ON TABLE public.hrm_reviews IS
  'HRM assessments (0196): one per (cycle, employment, kind, reviewer). Calibration never overwrites: calibrated_rating sits beside overall_rating with its reason. Privacy is a service property (grant, subject, reporting line), never storage.';
COMMENT ON TABLE public.hrm_review_answers IS
  'HRM review answer snapshot (0196): sections/questions copied from the template at instantiation so later template edits never rewrite an open cycle.';
COMMENT ON TABLE public.hrm_review_events IS
  'HRM append-only review lifecycle evidence (0196): instantiated, submitted, calibrated, shared, acknowledged, reopened. Corrections are new rows; updates are refused by trigger.';
COMMENT ON TABLE public.hrm_goals IS
  'HRM per-employment goals (0196): title, due date, exact-decimal weight, active/achieved/missed/cancelled, progress 0..100; achieved requires progress 100.';
COMMENT ON TABLE public.hrm_goal_updates IS
  'HRM append-only goal progress evidence (0196): corrections are new rows; updates are refused by trigger.';
COMMENT ON TABLE public.hrm_exit_records IS
  'HRM exit records (0196): one per terminated employment — reason kind, voluntary/regrettable/rehire flags, the paired exit interview, destination and notes. Corrections update the row; deletes are refused by trigger.';
