-- OpenBooks forward migration 0228_hrm_continuous_performance.
--
-- HR-17 continuous performance: what happens BETWEEN review cycles. HR-7
-- shipped the review cycle (0196); Lattice, Culture Amp, 15Five and
-- Leapsome win on the agenda that carries over, the feedback captured
-- when it happens, the competency reused everywhere, the calibration
-- grid with an audit trail, and the talent review that feeds succession.
--
-- Tables (all org-scoped, all under the org_isolation RLS below;
-- tenant isolation only — privacy is a SERVICE property enforced in
-- engine/src/hrm/performance/{one-on-ones,feedback,competencies,
-- calibration,talent}.ts, never a storage one, exactly like 0196):
--   hrm_one_on_ones — one scheduled conversation between a manager
--     employment and a report employment (scheduled, held, skipped,
--     cancelled). Recurrence is a rule ({every_weeks, weekday, time}),
--     never a year of rows: the service generates the next occurrence
--     when one is held or skipped. series_id links occurrences.
--   hrm_one_on_one_items — agenda rows (talking_point, action_item,
--     note) with visibility shared/private (private = author only,
--     enforced at read). A carried item is COPIED to the next
--     occurrence with carried_from_item_id and the original marked
--     carried — never moved, so history stays put.
--   hrm_feedback — append-only praise/feedback/request rows with the
--     refuse-update trigger below. A retraction is a new row of kind
--     retraction linking the original; reads hide both. Ratings here
--     are TEXT keys (proposed from the review's numeric overall_rating
--     formatted at write time is wrong — see calibration below).
--   hrm_competency_frameworks → hrm_competencies →
--     hrm_competency_levels — the org's reusable skill vocabulary with
--     ranked level expectations; hrm_competency_links attaches one
--     competency to job_level, position or review_template_section
--     targets. Job levels arrive with HR-12: the link kind exists now
--     and resolves when their table lands (feature-tolerant — the
--     service refuses job_level links until then by name).
--   hrm_calibration_sessions → hrm_calibration_entries →
--     hrm_calibration_events — the calibration grid over a cycle with
--     an audit trail. Ratings here are NUMERIC, matching hrm_reviews
--     overall_rating/calibrated_rating (0196 stores numbers, not keys):
--     proposed_rating snapshots the review's overall_rating at entry,
--     calibrated_rating is the decided figure, potential_key is text
--     against the org-declared scale labels from the review template.
--     Close writes calibrated_rating back onto hrm_reviews.calibrated_
--     rating in the same transaction as the close; events are
--     append-only evidence (opened, rating_changed, potential_set,
--     reverted, closed).
--   hrm_talent_reviews — the manager questionnaire per report per
--     cycle (performance/potential keys against the org-declared
--     scales, impact/risk of loss, promotion readiness). HR-only
--     reads: the subject never sees them (service-enforced).
--   hrm_succession_plans → hrm_succession_candidates — ranked
--     readiness pipelines per position. No candidate self-view exists.
--
-- Deletes: feedback rows, calibration events and talent reviews are
-- retained history. Draft calibration sessions and scheduled 1:1s may
-- be discarded. The governed amend path (openbooks.amend = on: fixture
-- teardown, sandbox wipe, org purge) is honoured so no row can pin its
-- organisation; production paths never set that GUC.
--
-- Additive only. Alters no payroll, recruiting or review table except
-- the additive hrm_reviews calibrated share columns below (nullable,
-- no backfill). Performs no backfill, exposes nothing to the generic
-- governed-query catalog.
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

CREATE TABLE IF NOT EXISTS public.hrm_one_on_ones (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    manager_employment_id uuid NOT NULL,
    report_employment_id uuid NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    held_at timestamp with time zone,
    status text NOT NULL DEFAULT 'scheduled',
    skip_reason text,
    recurrence jsonb,
    series_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_one_on_ones_status
      CHECK (status IN ('scheduled', 'held', 'skipped', 'cancelled')),
    CONSTRAINT hrm_one_on_ones_parties_differ
      CHECK (manager_employment_id <> report_employment_id),
    CONSTRAINT hrm_one_on_ones_held_paired
      CHECK ((status = 'held') = (held_at IS NOT NULL)),
    CONSTRAINT hrm_one_on_ones_skip_reason
      CHECK ((status <> 'skipped') OR (skip_reason IS NOT NULL AND char_length(btrim(skip_reason)) > 0)),
    CONSTRAINT hrm_one_on_ones_recurrence_shape
      CHECK (recurrence IS NULL
             OR (jsonb_typeof(recurrence) = 'object'
                 AND (recurrence ? 'every_weeks') AND (recurrence ? 'weekday')
                 AND jsonb_typeof(recurrence -> 'every_weeks') = 'number'
                 AND ((recurrence ->> 'every_weeks')::numeric >= 1)
                 AND ((recurrence ->> 'every_weeks')::numeric <= 12)
                 AND jsonb_typeof(recurrence -> 'weekday') = 'number'
                 AND ((recurrence ->> 'weekday')::numeric >= 0)
                 AND ((recurrence ->> 'weekday')::numeric <= 6))),
    CONSTRAINT hrm_one_on_ones_finite_time CHECK (
      scheduled_at >= '0001-01-01 00:00:00+00'::timestamptz
      AND scheduled_at <= '9999-12-31 23:59:59+00'::timestamptz
      AND (held_at IS NULL
           OR (held_at >= '0001-01-01 00:00:00+00'::timestamptz
               AND held_at <= '9999-12-31 23:59:59+00'::timestamptz))),
    CONSTRAINT hrm_one_on_ones_unique_slot UNIQUE (org_id, manager_employment_id, report_employment_id, scheduled_at)
);

CREATE TABLE IF NOT EXISTS public.hrm_one_on_one_items (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    one_on_one_id uuid NOT NULL,
    kind text NOT NULL,
    author_party_id uuid NOT NULL,
    body text NOT NULL,
    visibility text NOT NULL DEFAULT 'shared',
    status text NOT NULL DEFAULT 'open',
    carried_from_item_id uuid,
    assignee_party_id uuid,
    due_on date,
    position integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_one_on_one_items_kind
      CHECK (kind IN ('talking_point', 'action_item', 'note')),
    CONSTRAINT hrm_one_on_one_items_visibility
      CHECK (visibility IN ('shared', 'private')),
    CONSTRAINT hrm_one_on_one_items_status
      CHECK (status IN ('open', 'done', 'carried')),
    CONSTRAINT hrm_one_on_one_items_body
      CHECK (char_length(btrim(body)) > 0),
    CONSTRAINT hrm_one_on_one_items_position
      CHECK (position >= 0),
    CONSTRAINT hrm_one_on_one_items_carried_link
      CHECK ((status <> 'carried') OR (carried_from_item_id IS NULL)),
    CONSTRAINT hrm_one_on_one_items_due_finite CHECK (
      due_on IS NULL OR (due_on >= '0001-01-01'::date AND due_on <= '9999-12-31'::date))
);

CREATE TABLE IF NOT EXISTS public.hrm_feedback (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    subject_employment_id uuid NOT NULL,
    author_party_id uuid NOT NULL,
    kind text NOT NULL,
    visibility text NOT NULL,
    body text NOT NULL,
    context jsonb NOT NULL DEFAULT '{}'::jsonb,
    requested_from_party_id uuid,
    retracts_feedback_id uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT hrm_feedback_kind
      CHECK (kind IN ('praise', 'feedback', 'request', 'retraction')),
    CONSTRAINT hrm_feedback_visibility
      CHECK (visibility IN ('public', 'manager_and_subject', 'manager_only', 'subject_only')),
    CONSTRAINT hrm_feedback_praise_public_only
      CHECK ((visibility <> 'public') OR (kind = 'praise')),
    CONSTRAINT hrm_feedback_body
      CHECK (char_length(btrim(body)) > 0),
    CONSTRAINT hrm_feedback_request_shape
      CHECK ((kind <> 'request') OR (requested_from_party_id IS NOT NULL)),
    CONSTRAINT hrm_feedback_retraction_shape
      CHECK ((kind <> 'retraction') OR (retracts_feedback_id IS NOT NULL)),
    CONSTRAINT hrm_feedback_recorded_finite CHECK (
      recorded_at >= '0001-01-01 00:00:00+00'::timestamptz
      AND recorded_at <= '9999-12-31 23:59:59+00'::timestamptz)
);

CREATE TABLE IF NOT EXISTS public.hrm_competency_frameworks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_competency_frameworks_name
      CHECK (char_length(btrim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_competencies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    framework_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    category text,
    position integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_competencies_code
      CHECK (char_length(btrim(code)) > 0),
    CONSTRAINT hrm_competencies_name
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_competencies_position
      CHECK (position >= 0),
    CONSTRAINT hrm_competencies_unique_code UNIQUE (org_id, framework_id, code)
);

CREATE TABLE IF NOT EXISTS public.hrm_competency_levels (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    competency_id uuid NOT NULL,
    level_rank integer NOT NULL,
    label text NOT NULL,
    expectation text NOT NULL,
    CONSTRAINT hrm_competency_levels_rank
      CHECK (level_rank >= 1),
    CONSTRAINT hrm_competency_levels_label
      CHECK (char_length(btrim(label)) > 0),
    CONSTRAINT hrm_competency_levels_expectation
      CHECK (char_length(btrim(expectation)) > 0),
    CONSTRAINT hrm_competency_levels_unique_rank UNIQUE (org_id, competency_id, level_rank)
);

CREATE TABLE IF NOT EXISTS public.hrm_competency_links (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    competency_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT hrm_competency_links_kind
      CHECK (target_kind IN ('job_level', 'position', 'review_template_section')),
    CONSTRAINT hrm_competency_links_unique UNIQUE (org_id, competency_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS public.hrm_calibration_sessions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    name text NOT NULL,
    scope jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'draft',
    facilitator_party_id uuid,
    opened_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_calibration_sessions_name
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_calibration_sessions_status
      CHECK (status IN ('draft', 'open', 'closed')),
    CONSTRAINT hrm_calibration_sessions_opened_paired
      CHECK ((status IN ('open', 'closed')) = (opened_at IS NOT NULL)),
    CONSTRAINT hrm_calibration_sessions_closed_paired
      CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.hrm_calibration_entries (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    session_id uuid NOT NULL,
    review_id uuid NOT NULL,
    proposed_rating numeric(19,4),
    calibrated_rating numeric(19,4),
    potential_key text,
    justification text,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_calibration_entries_ratings_non_negative
      CHECK ((proposed_rating IS NULL OR proposed_rating >= 0)
         AND (calibrated_rating IS NULL OR calibrated_rating >= 0)),
    CONSTRAINT hrm_calibration_entries_decided_paired
      CHECK ((calibrated_rating IS NULL AND potential_key IS NULL)
             OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CONSTRAINT hrm_calibration_entries_unique_review UNIQUE (session_id, review_id)
);

CREATE TABLE IF NOT EXISTS public.hrm_calibration_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    session_id uuid NOT NULL,
    entry_id uuid,
    kind text NOT NULL,
    from_key text,
    to_key text,
    actor_user_id uuid,
    reason text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hrm_calibration_events_kind
      CHECK (kind IN ('opened', 'rating_changed', 'potential_set', 'reverted', 'closed')),
    CONSTRAINT hrm_calibration_events_recorded_finite CHECK (
      recorded_at >= '0001-01-01 00:00:00+00'::timestamptz
      AND recorded_at <= '9999-12-31 23:59:59+00'::timestamptz)
);

CREATE TABLE IF NOT EXISTS public.hrm_talent_reviews (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    cycle_id uuid,
    performance_key text NOT NULL,
    potential_key text NOT NULL,
    impact_of_loss text NOT NULL,
    risk_of_loss text NOT NULL,
    promotion_ready boolean NOT NULL DEFAULT false,
    notes text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_talent_reviews_keys
      CHECK (char_length(btrim(performance_key)) > 0 AND char_length(btrim(potential_key)) > 0),
    CONSTRAINT hrm_talent_reviews_loss
      CHECK (impact_of_loss IN ('low', 'medium', 'high') AND risk_of_loss IN ('low', 'medium', 'high')),
    CONSTRAINT hrm_talent_reviews_unique UNIQUE (org_id, employment_id, cycle_id)
);

CREATE TABLE IF NOT EXISTS public.hrm_succession_plans (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    position_id uuid NOT NULL,
    incumbent_employment_id uuid,
    status text NOT NULL DEFAULT 'draft',
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_succession_plans_status
      CHECK (status IN ('draft', 'active', 'archived')),
    CONSTRAINT hrm_succession_plans_unique UNIQUE (org_id, position_id)
);

CREATE TABLE IF NOT EXISTS public.hrm_succession_candidates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    readiness text NOT NULL,
    candidate_order integer NOT NULL DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_succession_candidates_readiness
      CHECK (readiness IN ('ready_now', 'one_to_two_years', 'three_plus')),
    CONSTRAINT hrm_succession_candidates_order
      CHECK (candidate_order >= 0),
    CONSTRAINT hrm_succession_candidates_unique UNIQUE (plan_id, employment_id)
);

-- A review template section may reference the competency it asks about
-- (0228 additive column, nullable): the review then renders the level
-- expectations inline at drafting time.
ALTER TABLE public.hrm_review_template_sections
  ADD COLUMN IF NOT EXISTS competency_id uuid;

-- Additive share columns on hrm_reviews: the employee-visible share shows
-- the calibrated rating with a calibration note (never the delta, never
-- the justification). Nullable: pre-0228 reviews share unchanged.
ALTER TABLE public.hrm_reviews
  ADD COLUMN IF NOT EXISTS calibrated_share_note text;
ALTER TABLE public.hrm_reviews
  ADD COLUMN IF NOT EXISTS calibrated_shared_at timestamp with time zone;

-- ---------------------------------------------------------------------------
-- Append-only guards: feedback rows and calibration events are evidence.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hrm_feedback_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'HRM feedback % is append-only evidence — retract it with a new retraction row instead of updating it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_feedback_immutable_trigger ON public.hrm_feedback;
CREATE TRIGGER hrm_feedback_immutable_trigger
  BEFORE UPDATE ON public.hrm_feedback
  FOR EACH ROW EXECUTE FUNCTION public.hrm_feedback_immutable_guard();

CREATE OR REPLACE FUNCTION public.hrm_feedback_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM feedback % is retained as history and cannot be deleted.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_feedback_no_delete_trigger ON public.hrm_feedback;
CREATE TRIGGER hrm_feedback_no_delete_trigger
  BEFORE DELETE ON public.hrm_feedback
  FOR EACH ROW EXECUTE FUNCTION public.hrm_feedback_no_delete();

CREATE OR REPLACE FUNCTION public.hrm_calibration_event_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'HRM calibration event % is append-only evidence — record a new event instead of updating it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_calibration_event_immutable_trigger ON public.hrm_calibration_events;
CREATE TRIGGER hrm_calibration_event_immutable_trigger
  BEFORE UPDATE ON public.hrm_calibration_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_calibration_event_immutable_guard();

CREATE OR REPLACE FUNCTION public.hrm_calibration_event_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM calibration event % is retained as history and cannot be deleted.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_calibration_event_no_delete_trigger ON public.hrm_calibration_events;
CREATE TRIGGER hrm_calibration_event_no_delete_trigger
  BEFORE DELETE ON public.hrm_calibration_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_calibration_event_no_delete();

-- Talent reviews and succession rows are retained history on the
-- production path (amend GUC still governs fixture teardown).
CREATE OR REPLACE FUNCTION public.hrm_talent_review_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM talent review % is retained as history and cannot be deleted.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_talent_review_no_delete_trigger ON public.hrm_talent_reviews;
CREATE TRIGGER hrm_talent_review_no_delete_trigger
  BEFORE DELETE ON public.hrm_talent_reviews
  FOR EACH ROW EXECUTE FUNCTION public.hrm_talent_review_no_delete();

-- ---------------------------------------------------------------------------
-- Indexes.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS hrm_one_on_ones_pair
  ON public.hrm_one_on_ones (org_id, manager_employment_id, report_employment_id, scheduled_at);
CREATE INDEX IF NOT EXISTS hrm_one_on_one_items_parent
  ON public.hrm_one_on_one_items (org_id, one_on_one_id, position);
CREATE INDEX IF NOT EXISTS hrm_feedback_subject
  ON public.hrm_feedback (org_id, subject_employment_id, recorded_at);
CREATE INDEX IF NOT EXISTS hrm_feedback_requested
  ON public.hrm_feedback (org_id, requested_from_party_id)
  WHERE kind = 'request';
CREATE INDEX IF NOT EXISTS hrm_competencies_framework
  ON public.hrm_competencies (org_id, framework_id, position);
CREATE INDEX IF NOT EXISTS hrm_competency_levels_competency
  ON public.hrm_competency_levels (org_id, competency_id, level_rank);
CREATE INDEX IF NOT EXISTS hrm_competency_links_target
  ON public.hrm_competency_links (org_id, target_kind, target_id);
CREATE INDEX IF NOT EXISTS hrm_calibration_entries_session
  ON public.hrm_calibration_entries (org_id, session_id);
CREATE INDEX IF NOT EXISTS hrm_calibration_events_session
  ON public.hrm_calibration_events (org_id, session_id, recorded_at);
CREATE INDEX IF NOT EXISTS hrm_talent_reviews_cycle
  ON public.hrm_talent_reviews (org_id, cycle_id);
CREATE INDEX IF NOT EXISTS hrm_succession_candidates_plan
  ON public.hrm_succession_candidates (org_id, plan_id, candidate_order);

-- ---------------------------------------------------------------------------
-- Tenant RLS (0195 pattern) for the new tables.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_one_on_ones', 'hrm_one_on_one_items', 'hrm_feedback',
    'hrm_competency_frameworks', 'hrm_competencies', 'hrm_competency_levels',
    'hrm_competency_links', 'hrm_calibration_sessions',
    'hrm_calibration_entries', 'hrm_calibration_events',
    'hrm_talent_reviews', 'hrm_succession_plans',
    'hrm_succession_candidates'
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

COMMENT ON TABLE public.hrm_one_on_ones IS
  'HRM 1:1 meetings (0228): scheduled conversations between a manager employment and a report employment; recurrence is a rule, never pre-generated rows.';
COMMENT ON TABLE public.hrm_feedback IS
  'HRM continuous feedback (0228): append-only praise/feedback/request rows; retraction is a new retraction row linking the original.';
COMMENT ON TABLE public.hrm_calibration_sessions IS
  'HRM calibration sessions (0228): the rating grid over a review cycle with append-only calibration events as the audit trail.';
COMMENT ON TABLE public.hrm_talent_reviews IS
  'HRM talent reviews (0228): manager 9-box input per report per cycle; HR-only reads, never visible to the subject.';
COMMENT ON TABLE public.hrm_succession_plans IS
  'HRM succession plans (0228): ranked readiness pipelines per position; no candidate self-view exists.';
