-- OpenBooks forward migration 0229_hrm_recruiting_depth.
--
-- RECRUITING DEPTH (HR-18): interview kits + blind scorecards, candidate
-- self-scheduling, template offers with e-sign, job-board publishing with
-- disposition sync, consent + retention rules, talent pools. HR-6 (0195)
-- built the funnel; this migration stores everything the depth layer needs
-- without touching the funnel's semantics.
--
-- CONFIGURATION (Setup registry, deactivation preserves history):
--   hrm_interview_kits: one row per org name with an optional pipeline
--     stage pin, free-text instructions, and the org-declared rating scale
--     (rating_scale text[]: the keys a scorecard overall + attribute
--     ratings may use; defaults to the four canonical keys). Storage CHECKs
--     the canonical vocabulary; the SERVICE refuses keys outside the kit's
--     declared scale, because storage cannot read the kit row.
--   hrm_scorecard_attributes: the kit's rated attributes (category,
--     attribute, position, is_focus_default). Focus attributes are the ones
--     a submission must rate; the rest are optional.
--   hrm_interview_kit_questions: suggested questions per kit, optionally
--     pinned to one attribute.
--   hrm_interviewer_pools: named interviewer groups with declared
--     availability windows (availability jsonb — windows the pool DECLARES,
--     never read from a calendar) and an optional default kit.
--   hrm_offer_templates: mustache body + clauses jsonb [{key, label, body,
--     default_on}] with an approval_required flag.
--   hrm_retention_rules: region scope + basis (inactivity/consent) +
--     retain_months + action (anonymize/delete). Deactivation preserves
--     history; a rule with runs is history-pinned by the RESTRICT FK.
--
-- RUNTIME:
--   hrm_scorecards + hrm_scorecard_ratings: one scorecard per
--     (interview, interviewer), UNIQUE. Submitted scorecards are immutable
--     except a pure audit touch (trigger). private_notes stay author-only
--     by the SERVICE (storage cannot know the reader); the blind rule —
--     an interviewer reads others' scorecards only after submitting their
--     own — is a SERVICE rule for the same reason.
--   hrm_interviews gains kit_id (nullable; RESTRICT — a kit with sittings
--     is history-pinned, deactivate it instead of deleting it) and
--     hrm_interview_panel gains focus_attribute_ids uuid[] (nullable).
--   hrm_interview_slots: proposed/booked/declined slot rows. The
--     self-booking link is a token whose SHA-256 hex is stored UNIQUE per
--     org (the raw token is shown once and emailed, never stored).
--     calendar_ref jsonb carries provider event ids; the provider itself is
--     an org-declared connector behind sync connections, NOT built here.
--     Reschedule history = the declined rows: rescheduling declines old
--     slots and proposes new ones in one transaction, never edits a booked
--     row into a different time.
--   hrm_offers gains template_id, version, rendered_file_id,
--     signature_status (the e-sign lifecycle: unsigned/sent/viewed/signed/
--     declined/voided — SEPARATE from the commercial status vocabulary,
--     which 0195 owns), signed_at, signed_evidence jsonb (the HMAC record:
--     signer name, timestamp, IP hash, document hash). Every regeneration
--     appends hrm_offer_versions (offer, version) — versions are immutable
--     evidence, never overwritten.
--   hrm_job_postings + hrm_posting_events: one posting per
--     (requisition, board_key). board_key is an org-declared connector key:
--     the generic layer ships 'internal' (the career page) and 'feed' (the
--     signed XML/JSON feed); named boards are connectors behind sync
--     connections. Events are append-only evidence (trigger). Applications
--     gain source_posting_id (nullable; RESTRICT — a posting with
--     applicants is history-pinned).
--   hrm_candidate_consents: one row per (candidate, purpose). purposes:
--     this_application, future_roles, talent_pool.
--   hrm_retention_runs: append-only per-rule run ledger (trigger).
--   hrm_candidates gains tags text[] (declared match tags for pool
--     rediscovery; empty by default).
--   hrm_talent_pools + hrm_talent_pool_members: named pools, UNIQUE
--     (pool, candidate).
--
-- RETENTION DELETE DECISION (documented per the brief's "decide and
-- document"): anonymize is the default action and keeps every row;
-- delete removes the candidate, their applications, and every dependent
-- row (interviews, panel, scorecards, ratings, slots, offers, offer
-- versions, consents, pool memberships) — EXCEPT hrm_application_events,
-- which survive as orphan-safe aggregates (kind, reason, recorded_at and
-- stage lineage are the funnel aggregate; readers never join them to
-- applications). To permit that, 0229 relaxes the 0195
-- events→applications tenant FK from RESTRICT to ON DELETE SET NULL and
-- makes application_id nullable; the SERVICE still requires a non-null
-- application on every append, so only the governed retention delete can
-- orphan an event. Orphaned events (application_id IS NULL) are excluded
-- from per-application reads and included in org funnel aggregates.
--
-- Additive otherwise. No backfill (new tables start empty; new columns
-- read null/default = the pre-kit history was unstructured), no change to
-- any existing CHECK member, RLS org_isolation on every new table, no
-- GENERATED column. HRM stays out of the generic governed-query catalog:
-- no openbooks_refresh_query_catalog call in this migration.
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

CREATE TABLE IF NOT EXISTS public.hrm_interview_kits (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    pipeline_stage_id uuid,
    instructions text,
    rating_scale text[] NOT NULL DEFAULT '{strong_no,no,yes,strong_yes}',
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_interview_kits_name_not_blank
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_interview_kits_scale_not_empty
      CHECK (cardinality(rating_scale) >= 2),
    CONSTRAINT hrm_interview_kits_scale_keys
      CHECK (rating_scale <@ ARRAY['strong_no', 'no', 'yes', 'strong_yes'])
);

CREATE TABLE IF NOT EXISTS public.hrm_scorecard_attributes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    kit_id uuid NOT NULL,
    category text NOT NULL,
    attribute text NOT NULL,
    description text,
    position integer NOT NULL,
    is_focus_default boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_scorecard_attributes_category_not_blank
      CHECK (char_length(btrim(category)) > 0),
    CONSTRAINT hrm_scorecard_attributes_attribute_not_blank
      CHECK (char_length(btrim(attribute)) > 0),
    CONSTRAINT hrm_scorecard_attributes_position
      CHECK (position >= 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_interview_kit_questions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    kit_id uuid NOT NULL,
    question text NOT NULL,
    position integer NOT NULL,
    attribute_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_interview_kit_questions_question_not_blank
      CHECK (char_length(btrim(question)) > 0),
    CONSTRAINT hrm_interview_kit_questions_position
      CHECK (position >= 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_scorecards (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    interview_id uuid NOT NULL,
    interviewer_party_id uuid NOT NULL,
    overall text,
    submitted_at timestamp with time zone,
    private_notes text,
    shared_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    -- Storage pins the canonical vocabulary; the kit's declared subset is
    -- enforced by the service, which is the only layer that reads the kit.
    CONSTRAINT hrm_scorecards_overall
      CHECK (overall IS NULL
             OR overall IN ('strong_no', 'no', 'yes', 'strong_yes')),
    -- An overall without a submission is a draft edit, not a verdict: the
    -- two travel together.
    CONSTRAINT hrm_scorecards_overall_paired
      CHECK ((overall IS NULL) = (submitted_at IS NULL)),
    CONSTRAINT hrm_scorecards_finite_time CHECK (
      submitted_at IS NULL
      OR (submitted_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
          AND submitted_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
);

CREATE TABLE IF NOT EXISTS public.hrm_scorecard_ratings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    scorecard_id uuid NOT NULL,
    attribute_id uuid NOT NULL,
    rating_key text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_scorecard_ratings_key
      CHECK (rating_key IN ('strong_no', 'no', 'yes', 'strong_yes'))
);

CREATE TABLE IF NOT EXISTS public.hrm_interview_slots (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    interview_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    timezone text NOT NULL,
    kind text NOT NULL DEFAULT 'proposed',
    proposed_by uuid,
    booked_by_candidate_at timestamp with time zone,
    calendar_ref jsonb,
    candidate_token_hash text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_interview_slots_kind
      CHECK (kind IN ('proposed', 'booked', 'declined')),
    CONSTRAINT hrm_interview_slots_ordered
      CHECK (starts_at < ends_at),
    CONSTRAINT hrm_interview_slots_timezone_not_blank
      CHECK (char_length(btrim(timezone)) > 0),
    -- A booking names when the candidate took it; a proposal never does.
    CONSTRAINT hrm_interview_slots_booking_paired
      CHECK ((kind = 'booked') = (booked_by_candidate_at IS NOT NULL)),
    CONSTRAINT hrm_interview_slots_finite_time CHECK (
      starts_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND starts_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND ends_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND ends_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND (booked_by_candidate_at IS NULL
           OR (booked_by_candidate_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND booked_by_candidate_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
      AND (expires_at IS NULL
           OR (expires_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND expires_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

CREATE TABLE IF NOT EXISTS public.hrm_interviewer_pools (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    member_party_ids uuid[] NOT NULL DEFAULT '{}',
    availability jsonb,
    kit_id uuid,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_interviewer_pools_name_not_blank
      CHECK (char_length(btrim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_offer_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    body_template text NOT NULL,
    clauses jsonb NOT NULL DEFAULT '[]',
    approval_required boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_offer_templates_name_not_blank
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_offer_templates_body_not_blank
      CHECK (char_length(btrim(body_template)) > 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_offer_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    version integer NOT NULL,
    payload jsonb NOT NULL,
    rendered_file_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT hrm_offer_versions_version
      CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS public.hrm_job_postings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    requisition_id uuid NOT NULL,
    board_key text NOT NULL,
    external_ref text,
    status text NOT NULL DEFAULT 'draft',
    published_at timestamp with time zone,
    closed_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_job_postings_board_not_blank
      CHECK (char_length(btrim(board_key)) > 0),
    CONSTRAINT hrm_job_postings_status
      CHECK (status IN ('draft', 'published', 'paused', 'closed', 'error')),
    -- A publication names when; a closure names when; an error names why.
    CONSTRAINT hrm_job_postings_published_paired
      CHECK ((status IN ('published', 'paused', 'closed')) = (published_at IS NOT NULL)),
    CONSTRAINT hrm_job_postings_closed_paired
      CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
    CONSTRAINT hrm_job_postings_error_paired
      CHECK ((status = 'error') = (error_message IS NOT NULL
              AND char_length(btrim(error_message)) > 0)),
    CONSTRAINT hrm_job_postings_finite_time CHECK (
      (published_at IS NULL
       OR (published_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
           AND published_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
      AND (closed_at IS NULL
       OR (closed_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
           AND closed_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

CREATE TABLE IF NOT EXISTS public.hrm_posting_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    posting_id uuid NOT NULL,
    kind text NOT NULL,
    payload jsonb,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hrm_posting_events_kind
      CHECK (kind IN ('published', 'paused', 'closed', 'apply_received',
                      'disposition_sent', 'error')),
    CONSTRAINT hrm_posting_events_finite_time CHECK (
      recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')
);

CREATE TABLE IF NOT EXISTS public.hrm_retention_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    region_scope jsonb NOT NULL DEFAULT '{}',
    basis text NOT NULL,
    retain_months integer NOT NULL,
    action text NOT NULL DEFAULT 'anonymize',
    consent_extension_lead_days integer,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_retention_rules_name_not_blank
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_retention_rules_basis
      CHECK (basis IN ('inactivity', 'consent')),
    CONSTRAINT hrm_retention_rules_action
      CHECK (action IN ('anonymize', 'delete')),
    CONSTRAINT hrm_retention_rules_retain_months
      CHECK (retain_months >= 1),
    CONSTRAINT hrm_retention_rules_lead_days
      CHECK (consent_extension_lead_days IS NULL
             OR consent_extension_lead_days >= 1)
);

CREATE TABLE IF NOT EXISTS public.hrm_retention_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    candidates_anonymized integer NOT NULL DEFAULT 0,
    candidates_deleted integer NOT NULL DEFAULT 0,
    extensions_requested integer NOT NULL DEFAULT 0,
    detail jsonb,
    CONSTRAINT hrm_retention_runs_counts
      CHECK (candidates_anonymized >= 0 AND candidates_deleted >= 0
             AND extensions_requested >= 0),
    CONSTRAINT hrm_retention_runs_finite_time CHECK (
      ran_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND ran_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')
);

CREATE TABLE IF NOT EXISTS public.hrm_candidate_consents (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    purpose text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    withdrawn_at timestamp with time zone,
    extension_requested_at timestamp with time zone,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_candidate_consents_purpose
      CHECK (purpose IN ('this_application', 'future_roles', 'talent_pool')),
    CONSTRAINT hrm_candidate_consents_source
      CHECK (source IN ('form', 'email', 'import')),
    CONSTRAINT hrm_candidate_consents_finite_time CHECK (
      granted_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND granted_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND (expires_at IS NULL
           OR (expires_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND expires_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
      AND (withdrawn_at IS NULL
           OR (withdrawn_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND withdrawn_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
      AND (extension_requested_at IS NULL
           OR (extension_requested_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND extension_requested_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

CREATE TABLE IF NOT EXISTS public.hrm_talent_pools (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_talent_pools_name_not_blank
      CHECK (char_length(btrim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_talent_pool_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    pool_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    CONSTRAINT hrm_talent_pool_members_finite_time CHECK (
      added_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND added_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')
);

-- ---------------------------------------------------------------------------
-- Additive ALTERs on 0195 tables.
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY public.hrm_interviews
  ADD COLUMN IF NOT EXISTS kit_id uuid;
ALTER TABLE ONLY public.hrm_interview_panel
  ADD COLUMN IF NOT EXISTS focus_attribute_ids uuid[];
ALTER TABLE ONLY public.hrm_offers
  ADD COLUMN IF NOT EXISTS template_id uuid,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rendered_file_id uuid,
  ADD COLUMN IF NOT EXISTS signature_status text,
  ADD COLUMN IF NOT EXISTS signed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS signed_evidence jsonb;
ALTER TABLE ONLY public.hrm_applications
  ADD COLUMN IF NOT EXISTS source_posting_id uuid;
ALTER TABLE ONLY public.hrm_candidates
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- The e-sign lifecycle rides beside the commercial status, never inside it:
-- an offer can be commercially sent while the signature is viewed, and
-- commercially accepted only through hire after the signature is signed.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_signature_status') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_signature_status
    CHECK (signature_status IS NULL
           OR signature_status IN ('unsigned', 'sent', 'viewed', 'signed', 'declined', 'voided'));
END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_signed_paired') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_signed_paired
    CHECK ((signature_status = 'signed') = (signed_at IS NOT NULL AND signed_evidence IS NOT NULL));
END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_version') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_version
    CHECK (version >= 1);
END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_signed_finite') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_signed_finite CHECK (
    signed_at IS NULL
    OR (signed_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
        AND signed_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'));
END IF; END $$;

-- Retention delete orphans events as aggregates (see header decision): the
-- 0195 RESTRICT pin becomes SET NULL and application_id becomes nullable.
-- The service still requires a live application on every append.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_application_tenant_fkey') THEN
    ALTER TABLE ONLY public.hrm_application_events
      DROP CONSTRAINT hrm_application_events_application_tenant_fkey;
  END IF;
END $$;
ALTER TABLE ONLY public.hrm_application_events
  ALTER COLUMN application_id DROP NOT NULL;
-- Single-column SET NULL (the 0195 stage-lineage precedent): the orphan
-- keeps its org_id — RLS and org funnel aggregates still scope it — while
-- the application link clears. Same-org is proven at append time by the
-- transitioning service, so a cross-org pointer cannot be written.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_application_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_application_events ADD CONSTRAINT hrm_application_events_application_tenant_fkey
    FOREIGN KEY (application_id) REFERENCES public.hrm_applications(id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Covering uniques, keys, indexes. All added defensively (re-runnable).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kits_pkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kits ADD CONSTRAINT hrm_interview_kits_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_attributes_pkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_attributes ADD CONSTRAINT hrm_scorecard_attributes_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kit_questions_pkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kit_questions ADD CONSTRAINT hrm_interview_kit_questions_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecards_pkey') THEN
  ALTER TABLE ONLY public.hrm_scorecards ADD CONSTRAINT hrm_scorecards_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_ratings_pkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_ratings ADD CONSTRAINT hrm_scorecard_ratings_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_slots_pkey') THEN
  ALTER TABLE ONLY public.hrm_interview_slots ADD CONSTRAINT hrm_interview_slots_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviewer_pools_pkey') THEN
  ALTER TABLE ONLY public.hrm_interviewer_pools ADD CONSTRAINT hrm_interviewer_pools_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_templates_pkey') THEN
  ALTER TABLE ONLY public.hrm_offer_templates ADD CONSTRAINT hrm_offer_templates_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_versions_pkey') THEN
  ALTER TABLE ONLY public.hrm_offer_versions ADD CONSTRAINT hrm_offer_versions_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_postings_pkey') THEN
  ALTER TABLE ONLY public.hrm_job_postings ADD CONSTRAINT hrm_job_postings_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_posting_events_pkey') THEN
  ALTER TABLE ONLY public.hrm_posting_events ADD CONSTRAINT hrm_posting_events_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_rules_pkey') THEN
  ALTER TABLE ONLY public.hrm_retention_rules ADD CONSTRAINT hrm_retention_rules_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_runs_pkey') THEN
  ALTER TABLE ONLY public.hrm_retention_runs ADD CONSTRAINT hrm_retention_runs_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidate_consents_pkey') THEN
  ALTER TABLE ONLY public.hrm_candidate_consents ADD CONSTRAINT hrm_candidate_consents_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pools_pkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pools ADD CONSTRAINT hrm_talent_pools_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pool_members_pkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pool_members ADD CONSTRAINT hrm_talent_pool_members_pkey PRIMARY KEY (id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kits_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_interview_kits ADD CONSTRAINT hrm_interview_kits_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_attributes_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_scorecard_attributes ADD CONSTRAINT hrm_scorecard_attributes_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kit_questions_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_interview_kit_questions ADD CONSTRAINT hrm_interview_kit_questions_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecards_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_scorecards ADD CONSTRAINT hrm_scorecards_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_ratings_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_scorecard_ratings ADD CONSTRAINT hrm_scorecard_ratings_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_slots_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_interview_slots ADD CONSTRAINT hrm_interview_slots_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviewer_pools_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_interviewer_pools ADD CONSTRAINT hrm_interviewer_pools_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_templates_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_offer_templates ADD CONSTRAINT hrm_offer_templates_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_versions_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_offer_versions ADD CONSTRAINT hrm_offer_versions_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_postings_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_job_postings ADD CONSTRAINT hrm_job_postings_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_posting_events_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_posting_events ADD CONSTRAINT hrm_posting_events_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_rules_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_retention_rules ADD CONSTRAINT hrm_retention_rules_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_runs_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_retention_runs ADD CONSTRAINT hrm_retention_runs_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidate_consents_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_candidate_consents ADD CONSTRAINT hrm_candidate_consents_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pools_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_talent_pools ADD CONSTRAINT hrm_talent_pools_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pool_members_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_talent_pool_members ADD CONSTRAINT hrm_talent_pool_members_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- Natural keys: one kit name per org, one position per kit list, one
-- scorecard per (interview, interviewer), one rating per
-- (scorecard, attribute), one posting per (requisition, board), one
-- consent per (candidate, purpose), one membership per (pool, candidate),
-- one version per (offer, version).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kits_org_name') THEN
  ALTER TABLE ONLY public.hrm_interview_kits ADD CONSTRAINT hrm_interview_kits_org_name
    UNIQUE (org_id, name); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_attributes_org_kit_position') THEN
  ALTER TABLE ONLY public.hrm_scorecard_attributes ADD CONSTRAINT hrm_scorecard_attributes_org_kit_position
    UNIQUE (org_id, kit_id, position); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kit_questions_org_kit_position') THEN
  ALTER TABLE ONLY public.hrm_interview_kit_questions ADD CONSTRAINT hrm_interview_kit_questions_org_kit_position
    UNIQUE (org_id, kit_id, position); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecards_org_interview_party') THEN
  ALTER TABLE ONLY public.hrm_scorecards ADD CONSTRAINT hrm_scorecards_org_interview_party
    UNIQUE (org_id, interview_id, interviewer_party_id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_ratings_org_scorecard_attribute') THEN
  ALTER TABLE ONLY public.hrm_scorecard_ratings ADD CONSTRAINT hrm_scorecard_ratings_org_scorecard_attribute
    UNIQUE (org_id, scorecard_id, attribute_id); END IF; END $$;
-- No UNIQUE on the token hash: one self-booking link covers the whole
-- proposed batch, so the hash repeats across the batch's rows. Lookup is by
-- (org, hash) through the partial index below; expiry is enforced per row.
-- Token hashes are 256-bit random, so cross-interview collision is not the
-- constraint's job.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviewer_pools_org_name') THEN
  ALTER TABLE ONLY public.hrm_interviewer_pools ADD CONSTRAINT hrm_interviewer_pools_org_name
    UNIQUE (org_id, name); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_templates_org_name') THEN
  ALTER TABLE ONLY public.hrm_offer_templates ADD CONSTRAINT hrm_offer_templates_org_name
    UNIQUE (org_id, name); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_versions_org_offer_version') THEN
  ALTER TABLE ONLY public.hrm_offer_versions ADD CONSTRAINT hrm_offer_versions_org_offer_version
    UNIQUE (org_id, offer_id, version); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_postings_org_requisition_board') THEN
  ALTER TABLE ONLY public.hrm_job_postings ADD CONSTRAINT hrm_job_postings_org_requisition_board
    UNIQUE (org_id, requisition_id, board_key); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_rules_org_name') THEN
  ALTER TABLE ONLY public.hrm_retention_rules ADD CONSTRAINT hrm_retention_rules_org_name
    UNIQUE (org_id, name); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidate_consents_org_candidate_purpose') THEN
  ALTER TABLE ONLY public.hrm_candidate_consents ADD CONSTRAINT hrm_candidate_consents_org_candidate_purpose
    UNIQUE (org_id, candidate_id, purpose); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pools_org_name') THEN
  ALTER TABLE ONLY public.hrm_talent_pools ADD CONSTRAINT hrm_talent_pools_org_name
    UNIQUE (org_id, name); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pool_members_pool_candidate') THEN
  ALTER TABLE ONLY public.hrm_talent_pool_members ADD CONSTRAINT hrm_talent_pool_members_pool_candidate
    UNIQUE (org_id, pool_id, candidate_id); END IF; END $$;

-- The token hash unique above admits many NULLs (one self-booking link per
-- interview at most is a SERVICE rule). NULL token rows never collide.
CREATE INDEX IF NOT EXISTS hrm_scorecards_interview
  ON public.hrm_scorecards USING btree (org_id, interview_id);
CREATE INDEX IF NOT EXISTS hrm_scorecard_ratings_scorecard
  ON public.hrm_scorecard_ratings USING btree (org_id, scorecard_id);
CREATE INDEX IF NOT EXISTS hrm_interview_slots_interview
  ON public.hrm_interview_slots USING btree (org_id, interview_id, kind);
CREATE INDEX IF NOT EXISTS hrm_interview_slots_upcoming
  ON public.hrm_interview_slots USING btree (org_id, kind, starts_at);
CREATE INDEX IF NOT EXISTS hrm_interview_slots_token
  ON public.hrm_interview_slots USING btree (org_id, candidate_token_hash)
  WHERE candidate_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS hrm_offer_versions_offer
  ON public.hrm_offer_versions USING btree (org_id, offer_id, version);
CREATE INDEX IF NOT EXISTS hrm_job_postings_requisition
  ON public.hrm_job_postings USING btree (org_id, requisition_id, status);
CREATE INDEX IF NOT EXISTS hrm_posting_events_posting
  ON public.hrm_posting_events USING btree (org_id, posting_id, recorded_at);
CREATE INDEX IF NOT EXISTS hrm_candidate_consents_candidate
  ON public.hrm_candidate_consents USING btree (org_id, candidate_id, purpose);
CREATE INDEX IF NOT EXISTS hrm_candidate_consents_expiry
  ON public.hrm_candidate_consents USING btree (org_id, expires_at) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS hrm_retention_runs_rule
  ON public.hrm_retention_runs USING btree (org_id, rule_id, ran_at);
CREATE INDEX IF NOT EXISTS hrm_talent_pool_members_pool
  ON public.hrm_talent_pool_members USING btree (org_id, pool_id);
CREATE INDEX IF NOT EXISTS hrm_talent_pool_members_candidate
  ON public.hrm_talent_pool_members USING btree (org_id, candidate_id);
CREATE INDEX IF NOT EXISTS hrm_interview_kits_stage
  ON public.hrm_interview_kits USING btree (org_id, pipeline_stage_id) WHERE pipeline_stage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hrm_offers_template
  ON public.hrm_offers USING btree (org_id, template_id) WHERE template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS hrm_applications_posting
  ON public.hrm_applications USING btree (org_id, source_posting_id) WHERE source_posting_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tenant foreign keys (composite org coherence, 0044 pattern). No ON DELETE
-- CASCADE on runtime history: kits/templates/rules pin their children
-- (RESTRICT), postings pin their events (RESTRICT — disposition evidence is
-- never cascade-deleted), offers pin their versions (RESTRICT — regeneration
-- evidence is never cascade-deleted). Children of a guarded parent follow
-- it: attributes/questions follow the kit, ratings follow the scorecard,
-- slots/scorecards follow the interview, members follow pool and candidate,
-- consents follow the candidate (erasure takes its receipts with it).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kits_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kits ADD CONSTRAINT hrm_interview_kits_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kits_stage_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kits ADD CONSTRAINT hrm_interview_kits_stage_tenant_fkey
    FOREIGN KEY (org_id, pipeline_stage_id) REFERENCES public.hrm_pipeline_stages(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_attributes_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_attributes ADD CONSTRAINT hrm_scorecard_attributes_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_attributes_kit_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_attributes ADD CONSTRAINT hrm_scorecard_attributes_kit_tenant_fkey
    FOREIGN KEY (org_id, kit_id) REFERENCES public.hrm_interview_kits(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kit_questions_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kit_questions ADD CONSTRAINT hrm_interview_kit_questions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kit_questions_kit_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kit_questions ADD CONSTRAINT hrm_interview_kit_questions_kit_tenant_fkey
    FOREIGN KEY (org_id, kit_id) REFERENCES public.hrm_interview_kits(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
-- Single-column SET NULL (the 0195 stage-lineage precedent): dropping an
-- attribute unpins the question without losing the org scope.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kit_questions_attribute_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kit_questions ADD CONSTRAINT hrm_interview_kit_questions_attribute_tenant_fkey
    FOREIGN KEY (attribute_id) REFERENCES public.hrm_scorecard_attributes(id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviews_kit_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviews ADD CONSTRAINT hrm_interviews_kit_tenant_fkey
    FOREIGN KEY (org_id, kit_id) REFERENCES public.hrm_interview_kits(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecards_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecards ADD CONSTRAINT hrm_scorecards_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecards_interview_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecards ADD CONSTRAINT hrm_scorecards_interview_tenant_fkey
    FOREIGN KEY (org_id, interview_id) REFERENCES public.hrm_interviews(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecards_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecards ADD CONSTRAINT hrm_scorecards_party_tenant_fkey
    FOREIGN KEY (org_id, interviewer_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_ratings_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_ratings ADD CONSTRAINT hrm_scorecard_ratings_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_ratings_scorecard_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_ratings ADD CONSTRAINT hrm_scorecard_ratings_scorecard_tenant_fkey
    FOREIGN KEY (org_id, scorecard_id) REFERENCES public.hrm_scorecards(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_ratings_attribute_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_ratings ADD CONSTRAINT hrm_scorecard_ratings_attribute_tenant_fkey
    FOREIGN KEY (org_id, attribute_id) REFERENCES public.hrm_scorecard_attributes(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_slots_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_slots ADD CONSTRAINT hrm_interview_slots_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_slots_interview_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_slots ADD CONSTRAINT hrm_interview_slots_interview_tenant_fkey
    FOREIGN KEY (org_id, interview_id) REFERENCES public.hrm_interviews(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviewer_pools_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviewer_pools ADD CONSTRAINT hrm_interviewer_pools_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviewer_pools_kit_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviewer_pools ADD CONSTRAINT hrm_interviewer_pools_kit_tenant_fkey
    FOREIGN KEY (org_id, kit_id) REFERENCES public.hrm_interview_kits(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_templates_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_offer_templates ADD CONSTRAINT hrm_offer_templates_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_template_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_template_tenant_fkey
    FOREIGN KEY (org_id, template_id) REFERENCES public.hrm_offer_templates(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_rendered_file_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_rendered_file_tenant_fkey
    FOREIGN KEY (org_id, rendered_file_id) REFERENCES public.files(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_versions_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_offer_versions ADD CONSTRAINT hrm_offer_versions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_versions_offer_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offer_versions ADD CONSTRAINT hrm_offer_versions_offer_tenant_fkey
    FOREIGN KEY (org_id, offer_id) REFERENCES public.hrm_offers(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_versions_rendered_file_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offer_versions ADD CONSTRAINT hrm_offer_versions_rendered_file_tenant_fkey
    FOREIGN KEY (org_id, rendered_file_id) REFERENCES public.files(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_postings_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_job_postings ADD CONSTRAINT hrm_job_postings_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_postings_requisition_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_job_postings ADD CONSTRAINT hrm_job_postings_requisition_tenant_fkey
    FOREIGN KEY (org_id, requisition_id) REFERENCES public.hrm_requisitions(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_posting_events_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_posting_events ADD CONSTRAINT hrm_posting_events_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_posting_events_posting_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_posting_events ADD CONSTRAINT hrm_posting_events_posting_tenant_fkey
    FOREIGN KEY (org_id, posting_id) REFERENCES public.hrm_job_postings(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_posting_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_posting_tenant_fkey
    FOREIGN KEY (org_id, source_posting_id) REFERENCES public.hrm_job_postings(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_rules_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_retention_rules ADD CONSTRAINT hrm_retention_rules_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_runs_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_retention_runs ADD CONSTRAINT hrm_retention_runs_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_runs_rule_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_retention_runs ADD CONSTRAINT hrm_retention_runs_rule_tenant_fkey
    FOREIGN KEY (org_id, rule_id) REFERENCES public.hrm_retention_rules(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidate_consents_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidate_consents ADD CONSTRAINT hrm_candidate_consents_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidate_consents_candidate_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidate_consents ADD CONSTRAINT hrm_candidate_consents_candidate_tenant_fkey
    FOREIGN KEY (org_id, candidate_id) REFERENCES public.hrm_candidates(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pools_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pools ADD CONSTRAINT hrm_talent_pools_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pool_members_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pool_members ADD CONSTRAINT hrm_talent_pool_members_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pool_members_pool_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pool_members ADD CONSTRAINT hrm_talent_pool_members_pool_tenant_fkey
    FOREIGN KEY (org_id, pool_id) REFERENCES public.hrm_talent_pools(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pool_members_candidate_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pool_members ADD CONSTRAINT hrm_talent_pool_members_candidate_tenant_fkey
    FOREIGN KEY (org_id, candidate_id) REFERENCES public.hrm_candidates(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;

-- Frozen evidence actors (0185 pattern): single-column RESTRICT with no
-- same-org assertion (home-org users), and therefore never nulled.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kits_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kits ADD CONSTRAINT hrm_interview_kits_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kits_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kits ADD CONSTRAINT hrm_interview_kits_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_attributes_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_attributes ADD CONSTRAINT hrm_scorecard_attributes_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_attributes_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_attributes ADD CONSTRAINT hrm_scorecard_attributes_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kit_questions_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kit_questions ADD CONSTRAINT hrm_interview_kit_questions_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_kit_questions_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_kit_questions ADD CONSTRAINT hrm_interview_kit_questions_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecards_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecards ADD CONSTRAINT hrm_scorecards_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecards_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecards ADD CONSTRAINT hrm_scorecards_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_ratings_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_ratings ADD CONSTRAINT hrm_scorecard_ratings_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_scorecard_ratings_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_scorecard_ratings ADD CONSTRAINT hrm_scorecard_ratings_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_slots_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_slots ADD CONSTRAINT hrm_interview_slots_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_slots_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_slots ADD CONSTRAINT hrm_interview_slots_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_slots_proposed_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_slots ADD CONSTRAINT hrm_interview_slots_proposed_by_fkey
    FOREIGN KEY (proposed_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviewer_pools_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviewer_pools ADD CONSTRAINT hrm_interviewer_pools_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviewer_pools_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviewer_pools ADD CONSTRAINT hrm_interviewer_pools_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_templates_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_offer_templates ADD CONSTRAINT hrm_offer_templates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_templates_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_offer_templates ADD CONSTRAINT hrm_offer_templates_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offer_versions_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_offer_versions ADD CONSTRAINT hrm_offer_versions_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_postings_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_job_postings ADD CONSTRAINT hrm_job_postings_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_postings_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_job_postings ADD CONSTRAINT hrm_job_postings_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_rules_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_retention_rules ADD CONSTRAINT hrm_retention_rules_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_retention_rules_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_retention_rules ADD CONSTRAINT hrm_retention_rules_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidate_consents_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidate_consents ADD CONSTRAINT hrm_candidate_consents_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidate_consents_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidate_consents ADD CONSTRAINT hrm_candidate_consents_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pools_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pools ADD CONSTRAINT hrm_talent_pools_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pools_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pools ADD CONSTRAINT hrm_talent_pools_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_talent_pool_members_added_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_talent_pool_members ADD CONSTRAINT hrm_talent_pool_members_added_by_fkey
    FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Storage triggers.
-- ---------------------------------------------------------------------------

-- A submitted scorecard is a signed verdict: it is immutable except a pure
-- audit touch; unsubmitted (draft) scorecards stay editable so an
-- interviewer can work incrementally. Deletes ride the governed amend
-- path only (fixture teardown, org wipe — the 0184/0188 house mechanism,
-- never a production path).
CREATE OR REPLACE FUNCTION public.hrm_scorecard_submitted_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hrm_scorecards: scorecards are retained as history — a submitted verdict is never deleted'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.submitted_at IS NOT NULL
     AND to_jsonb(NEW) - ARRAY['updated_at','updated_by']
       <> to_jsonb(OLD) - ARRAY['updated_at','updated_by'] THEN
    RAISE EXCEPTION 'hrm_scorecards: a submitted scorecard is immutable — the verdict stands as recorded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.hrm_scorecard_submitted_immutable() IS
  'openbooks:hrm_scorecard_submitted_immutable:v1 - submitted scorecards immutable except a pure audit touch; deletes only on the governed amend path';

DROP TRIGGER IF EXISTS hrm_scorecards_submitted_immutable ON public.hrm_scorecards;
CREATE TRIGGER hrm_scorecards_submitted_immutable
  BEFORE UPDATE OR DELETE ON public.hrm_scorecards
  FOR EACH ROW EXECUTE FUNCTION public.hrm_scorecard_submitted_immutable();

-- Offer versions, posting events and retention runs are append-only
-- evidence ledgers: never updated, deleted only on the governed amend
-- path (the hrm_application_events_immutable standing, 0195).
CREATE OR REPLACE FUNCTION public.hrm_recruiting_depth_append_only()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%.%: evidence rows are append-only — they are never deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION '%.%: evidence rows are append-only — record a new row instead of editing one', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '23514';
END $$;

COMMENT ON FUNCTION public.hrm_recruiting_depth_append_only() IS
  'openbooks:hrm_recruiting_depth_append_only:v1 - offer versions, posting events and retention runs append-only; updates refused on every path, deletes only on the governed amend path';

DROP TRIGGER IF EXISTS hrm_offer_versions_append_only ON public.hrm_offer_versions;
CREATE TRIGGER hrm_offer_versions_append_only
  BEFORE UPDATE OR DELETE ON public.hrm_offer_versions
  FOR EACH ROW EXECUTE FUNCTION public.hrm_recruiting_depth_append_only();
DROP TRIGGER IF EXISTS hrm_posting_events_append_only ON public.hrm_posting_events;
CREATE TRIGGER hrm_posting_events_append_only
  BEFORE UPDATE OR DELETE ON public.hrm_posting_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_recruiting_depth_append_only();
DROP TRIGGER IF EXISTS hrm_retention_runs_append_only ON public.hrm_retention_runs;
CREATE TRIGGER hrm_retention_runs_append_only
  BEFORE UPDATE OR DELETE ON public.hrm_retention_runs
  FOR EACH ROW EXECUTE FUNCTION public.hrm_recruiting_depth_append_only();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0177/0181 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all sixteen tables. HRM stays out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_interview_kits', 'hrm_scorecard_attributes',
    'hrm_interview_kit_questions', 'hrm_scorecards', 'hrm_scorecard_ratings',
    'hrm_interview_slots', 'hrm_interviewer_pools', 'hrm_offer_templates',
    'hrm_offer_versions', 'hrm_job_postings', 'hrm_posting_events',
    'hrm_retention_rules', 'hrm_retention_runs', 'hrm_candidate_consents',
    'hrm_talent_pools', 'hrm_talent_pool_members'] LOOP
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

COMMENT ON TABLE public.hrm_interview_kits IS
  'HRM structured-interview kits (0229): one named kit per org with an optional pipeline-stage pin, instructions, and the org-declared rating scale. A kit with sittings is history-pinned; deactivate it instead of deleting it.';
COMMENT ON TABLE public.hrm_scorecard_attributes IS
  'HRM scorecard attributes (0229): the rated attributes of an interview kit, ordered by position. is_focus_default marks the attributes a submission must rate; children of the kit.';
COMMENT ON TABLE public.hrm_interview_kit_questions IS
  'HRM kit questions (0229): suggested interview questions per kit, optionally pinned to one attribute; children of the kit.';
COMMENT ON TABLE public.hrm_scorecards IS
  'HRM interview verdicts (0229): one scorecard per (interview, interviewer). Drafts stay editable; submitted verdicts are immutable except a pure audit touch. private_notes are author-only by the read service.';
COMMENT ON TABLE public.hrm_scorecard_ratings IS
  'HRM scorecard ratings (0229): one rating per (scorecard, attribute); children of the scorecard.';
COMMENT ON TABLE public.hrm_interview_slots IS
  'HRM self-scheduling slots (0229): proposed/booked/declined rows per interview. One booking link covers a proposed batch, so its SHA-256 hex repeats across the batch rows; the raw token is never stored. calendar_ref carries provider event ids — the provider is an org-declared connector, not built here.';
COMMENT ON TABLE public.hrm_interviewer_pools IS
  'HRM interviewer pools (0229): named interviewer groups with declared availability windows (never read from a calendar) and an optional default kit.';
COMMENT ON TABLE public.hrm_offer_templates IS
  'HRM offer templates (0229): mustache body plus clause rows with an approval flag. A template with offers is history-pinned; deactivate it instead of deleting it.';
COMMENT ON TABLE public.hrm_offer_versions IS
  'HRM offer regeneration evidence (0229): every render appends a version, never an overwrite. Append-only.';
COMMENT ON TABLE public.hrm_job_postings IS
  'HRM job-board postings (0229): one posting per (requisition, board_key). board_key is an org-declared connector key; the generic layer ships internal and feed. A posting with applicants or events is history-pinned.';
COMMENT ON TABLE public.hrm_posting_events IS
  'HRM posting evidence (0229): the append-only event ledger for publishes, pauses, closes, received applications, sent dispositions and errors. Append-only.';
COMMENT ON TABLE public.hrm_retention_rules IS
  'HRM retention rules (0229): region scope plus inactivity/consent basis, retain months, and anonymize/delete action. A rule with runs is history-pinned.';
COMMENT ON TABLE public.hrm_retention_runs IS
  'HRM retention run ledger (0229): one append-only row per rule evaluation with counts and detail. Append-only.';
COMMENT ON TABLE public.hrm_candidate_consents IS
  'HRM candidate consents (0229): one row per (candidate, purpose) with grant, expiry, withdrawal and extension-request evidence. Erasure takes its receipts with it.';
COMMENT ON TABLE public.hrm_talent_pools IS
  'HRM talent pools (0229): named candidate pools for rediscovery against open requisitions.';
COMMENT ON TABLE public.hrm_talent_pool_members IS
  'HRM talent pool membership (0229): join rows between pools and candidates, children of both guarded parents.';
