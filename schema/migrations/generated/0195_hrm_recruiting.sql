-- OpenBooks forward migration 0195_hrm_recruiting.
--
-- Recruiting (HR-6): requisitions, candidates, pipeline, interviews, offers,
-- hire. A vacancy today has no path to a hire except a manual employee
-- record; recruiting closes that loop. A requisition opens AGAINST a
-- position (or a planned headcount) with its own funnel; candidates move
-- through a configurable pipeline with recorded events; an accepted offer
-- becomes the hire — through the SAME change-request and Flows path every
-- other employment start uses — and the requisition fills when its
-- headcount is met.
--
-- CONFIGURATION (Setup registry, deactivation preserves history):
--   hrm_pipeline_templates: one row per org name; is_default marks the
--     funnel new requisitions use when none is named. Exactly one default
--     per org (partial unique index). A template that opened requisitions
--     is history-pinned: the BEFORE DELETE trigger names the deactivation
--     remedy before the RESTRICT FK fires.
--   hrm_pipeline_stages: ordered rows (unique position per template, unique
--     key per template) with a kind in screening, interview, assessment,
--     offer, hired, rejected. is_terminal is exactly (kind in hired,
--     rejected): the funnel ends in hired or rejected, never in a step the
--     service could keep moving. There is exactly one hired stage and at
--     most one rejected stage per template shape-wise; the service owns
--     which stage is first and refuses moves across templates.
--
-- RUNTIME (snapshot history, never rewritten):
--   hrm_requisitions: the vacancy to fill. requisition_number is an org
--     sequence (allocated through number_sequences with document_kind
--     'hrm_requisition', the same serialized upsert the document allocator
--     uses — one org-wide counter, concurrent openers serialize instead of
--     colliding). position_id is nullable (a planned headcount with no
--     position yet); employer_subsidiary_id is NOT NULL (headcount is never
--     misattributed to no legal entity). filled_count <= headcount is
--     storage; the fill itself happens only through hire (the service bumps
--     filled_count in the hire transaction and flips status to filled when
--     headcount is met). Compensation travels as an all-or-nothing triple
--     (min, max, currency, basis): a range with no currency, or a currency
--     with no basis, is not stored as a half-range. revision is the
--     aggregate concurrency revision: hire bumps it by exactly one with the
--     filled_count write, and a zero-row write is a refusal, never success.
--   hrm_candidates: the person, before they are a party. party_id is set
--     ONLY when hired (the hire transaction links the created/reused
--     employee party); until then the candidate is display_name + contact
--     PII. Email duplicates are a SERVICE refusal with the mergeInto remedy
--     (storage cannot express "unique unless merging"), so no unique index
--     here. Contact PII is masked in sandboxes like parties (see
--     engine/src/sandbox/masking.ts); candidates never appear in backup
--     cross-org checks.
--   hrm_applications: one row per (requisition, candidate) — UNIQUE
--     (org_id, requisition_id, candidate_id). stage_id always names a stage
--     of the requisition's pipeline template (proven by the service; storage
--     pins same-org via the composite FK). Terminal rows (rejected,
--     withdrawn, hired) are immutable except a pure audit touch; deletes
--     admitted only on the governed amend path (openbooks.amend, fixture
--     teardown / org wipe — the 0184/0188 house mechanism, never a
--     production path).
--   hrm_application_events: the append-only evidence ledger for the funnel
--     (applied, stage_changed, rejected, withdrawn, offer_created,
--     offer_sent, offer_accepted, offer_declined, offer_withdrawn, hired,
--     merged, note). Every transition appends an event in the same
--     transaction as the state write. A BEFORE UPDATE OR DELETE trigger
--     refuses unconditionally (evidence immutable, like employment_changes).
--     from_stage_id / to_stage_id are LINEAGE (single-column SET NULL: they
--     prove which row was left/entered, never scope — the snapshot columns
--     are the record). actor_id is a frozen evidence actor like 0185
--     submitted_by (users(id) RESTRICT, no same-org assertion — home-org
--     users — and therefore never nulled).
--   hrm_interviews + hrm_interview_panel: one interview row per sitting
--     (kind phone, video, onsite, panel, assessment); panel members ride the
--     join table (children of a guarded parent: CASCADE with the interview).
--     Completed interviews are immutable except a pure audit touch; deletes
--     only on the governed amend path. outcome is set only on completion.
--   hrm_offers: the proposed terms. At most one LIVE offer per application:
--     a partial unique index over (org_id, application_id) WHERE status IN
--     ('draft', 'sent') — concurrent creators serialize instead of
--     duplicating (a BEFORE trigger would go blind under READ COMMITTED,
--     per the 0184 rule). Terminal offers are immutable except a pure audit
--     touch; deletes only on the governed amend path. approved_change_id
--     names the hire change request (composite tenant FK, INITIALLY
--     DEFERRED like 0193 opened_by_change_id: the request row and the offer
--     update commit in one hire transaction, in any order). Expiry is
--     COMPUTED on read and materialised on the next write (no background
--     sweeper owns offer state); an expires_on in the past with status sent
--     is reported expired by the reader.
--
-- HIRE writes no employment: the employment comes into existence when the
-- hire change request is approved, as today — recruiting never writes
-- worker_employments (only the reserved identity the change-request path
-- requires, inside the hire transaction that also files the draft).
--
-- HRM stays out of the generic governed-query catalog: no
-- openbooks_refresh_query_catalog call in this migration.
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

CREATE TABLE IF NOT EXISTS public.hrm_pipeline_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    is_default boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_pipeline_templates_name
      CHECK (char_length(btrim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS public.hrm_pipeline_stages (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    position integer NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    is_terminal boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_pipeline_stages_position
      CHECK (position >= 0),
    CONSTRAINT hrm_pipeline_stages_key
      CHECK (char_length(btrim(key)) > 0),
    CONSTRAINT hrm_pipeline_stages_name
      CHECK (char_length(btrim(name)) > 0),
    CONSTRAINT hrm_pipeline_stages_kind
      CHECK (kind IN ('screening', 'interview', 'assessment', 'offer', 'hired', 'rejected')),
    -- The funnel ends exactly in hired or rejected: terminality is derived
    -- from kind, never an independent flag a writer could set wrong.
    CONSTRAINT hrm_pipeline_stages_terminal
      CHECK (is_terminal = (kind IN ('hired', 'rejected')))
);

CREATE TABLE IF NOT EXISTS public.hrm_requisitions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    -- Org-wide human handle (e.g. 'REQ-00042'), allocated from the
    -- number_sequences row (org_id, 'hrm_requisition', NULL) by the service.
    requisition_number text NOT NULL,
    -- The establishment slot this vacancy fills; null = planned headcount
    -- with no position yet. Over-establishment (no vacant FTE) is a service
    -- refusal with the --over-establishment remedy, never silent.
    position_id uuid,
    title text NOT NULL,
    -- Legal employer owning this headcount. Non-null: a vacancy must never
    -- be misattributed to no legal entity.
    employer_subsidiary_id uuid NOT NULL,
    department_id uuid,
    location_id uuid,
    hiring_manager_party_id uuid,
    recruiter_user_id uuid,
    headcount integer NOT NULL,
    -- Filled only through hire (the hire transaction bumps this with the
    -- aggregate revision); never written directly by any other path.
    filled_count integer NOT NULL DEFAULT 0,
    employment_kind text,
    target_start_on date,
    compensation_min numeric,
    compensation_max numeric,
    compensation_currency char(3),
    compensation_basis text,
    status text NOT NULL DEFAULT 'draft',
    opened_on date,
    closed_on date,
    close_reason text,
    pipeline_template_id uuid,
    description text,
    -- Aggregate optimistic-concurrency revision, bumped by exactly one on
    -- ANY hire fill under this requisition. Writers match this revision and
    -- increment it in one UPDATE; a zero-row write is a refusal.
    revision integer NOT NULL DEFAULT 1,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_requisitions_number_not_blank
      CHECK (char_length(btrim(requisition_number)) > 0),
    CONSTRAINT hrm_requisitions_title_not_blank
      CHECK (char_length(btrim(title)) > 0),
    CONSTRAINT hrm_requisitions_headcount
      CHECK (headcount >= 1),
    CONSTRAINT hrm_requisitions_filled_count
      CHECK (filled_count >= 0),
    -- The fill can never exceed the opening: storage pins it, the hire
    -- service refuses by name before storage would.
    CONSTRAINT hrm_requisitions_filled_bounded
      CHECK (filled_count <= headcount),
    CONSTRAINT hrm_requisitions_revision
      CHECK (revision >= 1),
    CONSTRAINT hrm_requisitions_employment_kind
      CHECK (employment_kind IS NULL OR char_length(btrim(employment_kind)) > 0),
    CONSTRAINT hrm_requisitions_status
      CHECK (status IN ('draft', 'open', 'on_hold', 'filled', 'cancelled')),
    -- Compensation travels as an all-or-nothing triple: a range with no
    -- currency, or a currency with no basis, is not stored as a half-range.
    CONSTRAINT hrm_requisitions_compensation_paired
      CHECK ((compensation_min IS NULL) = (compensation_max IS NULL)
         AND (compensation_min IS NULL) = (compensation_currency IS NULL)
         AND (compensation_min IS NULL) = (compensation_basis IS NULL)),
    CONSTRAINT hrm_requisitions_compensation_range
      CHECK (compensation_min IS NULL OR compensation_max IS NULL
             OR compensation_min <= compensation_max),
    CONSTRAINT hrm_requisitions_compensation_basis
      CHECK (compensation_basis IS NULL OR compensation_basis IN ('hourly', 'annual')),
    -- A cancelled opening names why; a closed opening (filled or cancelled)
    -- names when. The open/hold/resume lifecycle itself is service-owned.
    CONSTRAINT hrm_requisitions_cancel_reason
      CHECK ((status = 'cancelled') = (close_reason IS NOT NULL AND char_length(btrim(close_reason)) > 0)),
    CONSTRAINT hrm_requisitions_closed_paired
      CHECK ((status IN ('filled', 'cancelled')) = (closed_on IS NOT NULL)),
    CONSTRAINT hrm_requisitions_opened_paired
      CHECK (status IN ('draft', 'cancelled') OR opened_on IS NOT NULL),
    CONSTRAINT hrm_requisitions_finite_time CHECK (
      (target_start_on IS NULL
        OR target_start_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND (opened_on IS NULL
        OR opened_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND (closed_on IS NULL
        OR closed_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'))
);

CREATE TABLE IF NOT EXISTS public.hrm_candidates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    -- Set ONLY when hired (the hire transaction links the created or reused
    -- employee party). Until then the candidate is a name plus contact PII,
    -- never a party: a party would make a prospect countable as workforce.
    party_id uuid,
    display_name text NOT NULL,
    email text,
    phone text,
    source text,
    source_detail text,
    resume_attachment_id uuid,
    consent_recorded_at timestamp with time zone,
    is_internal boolean NOT NULL DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_candidates_name_not_blank
      CHECK (char_length(btrim(display_name)) > 0),
    CONSTRAINT hrm_candidates_email_not_blank
      CHECK (email IS NULL OR char_length(btrim(email)) > 0),
    CONSTRAINT hrm_candidates_phone_not_blank
      CHECK (phone IS NULL OR char_length(btrim(phone)) > 0),
    CONSTRAINT hrm_candidates_source
      CHECK (source IS NULL
             OR source IN ('referral', 'job_board', 'agency', 'direct', 'internal', 'other')),
    CONSTRAINT hrm_candidates_finite_time CHECK (
      consent_recorded_at IS NULL
      OR (consent_recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
          AND consent_recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
);

CREATE TABLE IF NOT EXISTS public.hrm_applications (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    requisition_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    -- Always a stage of the requisition's pipeline template (proven by the
    -- service on every move; storage pins same-org via the composite FK).
    stage_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'active',
    applied_on date NOT NULL,
    rejected_reason text,
    rejected_at timestamp with time zone,
    withdrawn_at timestamp with time zone,
    hired_employment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_applications_status
      CHECK (status IN ('active', 'rejected', 'withdrawn', 'hired')),
    -- A rejection names why and when; a withdrawal names when; a hire names
    -- the reserved employment the change request was filed against.
    CONSTRAINT hrm_applications_rejected_paired
      CHECK ((status = 'rejected') = (rejected_reason IS NOT NULL
              AND char_length(btrim(rejected_reason)) > 0
              AND rejected_at IS NOT NULL)),
    CONSTRAINT hrm_applications_withdrawn_paired
      CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
    CONSTRAINT hrm_applications_hired_paired
      CHECK ((status = 'hired') = (hired_employment_id IS NOT NULL)),
    CONSTRAINT hrm_applications_finite_time CHECK (
      applied_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (rejected_at IS NULL
           OR (rejected_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND rejected_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
      AND (withdrawn_at IS NULL
           OR (withdrawn_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND withdrawn_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

CREATE TABLE IF NOT EXISTS public.hrm_application_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    application_id uuid NOT NULL,
    kind text NOT NULL,
    from_stage_id uuid,
    to_stage_id uuid,
    reason text,
    actor_id uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hrm_application_events_kind
      CHECK (kind IN ('applied', 'stage_changed', 'rejected', 'withdrawn',
                      'offer_created', 'offer_sent', 'offer_accepted',
                      'offer_declined', 'offer_withdrawn', 'hired', 'merged', 'note')),
    CONSTRAINT hrm_application_events_finite_time CHECK (
      recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')
);

CREATE TABLE IF NOT EXISTS public.hrm_interviews (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    application_id uuid NOT NULL,
    kind text NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    duration_minutes integer,
    location text,
    status text NOT NULL DEFAULT 'scheduled',
    outcome text,
    feedback text,
    scorecard jsonb,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_interviews_kind
      CHECK (kind IN ('phone', 'video', 'onsite', 'panel', 'assessment')),
    CONSTRAINT hrm_interviews_status
      CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
    -- An outcome is the completion verdict: set only on completion.
    CONSTRAINT hrm_interviews_outcome
      CHECK (outcome IS NULL
             OR (status = 'completed' AND outcome IN ('advance', 'hold', 'reject'))),
    CONSTRAINT hrm_interviews_completed_paired
      CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CONSTRAINT hrm_interviews_duration
      CHECK (duration_minutes IS NULL OR duration_minutes > 0),
    CONSTRAINT hrm_interviews_location_not_blank
      CHECK (location IS NULL OR char_length(btrim(location)) > 0),
    CONSTRAINT hrm_interviews_finite_time CHECK (
      scheduled_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND scheduled_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND (completed_at IS NULL
           OR (completed_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND completed_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

CREATE TABLE IF NOT EXISTS public.hrm_interview_panel (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    interview_id uuid NOT NULL,
    party_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_offers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    application_id uuid NOT NULL,
    position_id uuid,
    -- Legal employer of the proposed employment. Non-null like the
    -- requisition: an offer must never float outside a legal entity.
    employer_subsidiary_id uuid NOT NULL,
    department_id uuid,
    job_title text NOT NULL,
    employment_kind text,
    proposed_start_on date NOT NULL,
    compensation_amount numeric NOT NULL,
    compensation_currency char(3) NOT NULL,
    compensation_basis text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    sent_at timestamp with time zone,
    expires_on date,
    responded_at timestamp with time zone,
    decline_reason text,
    -- The hire change request filed when this offer was accepted. Set in
    -- the hire transaction; null until then.
    approved_change_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_offers_title_not_blank
      CHECK (char_length(btrim(job_title)) > 0),
    CONSTRAINT hrm_offers_employment_kind
      CHECK (employment_kind IS NULL OR char_length(btrim(employment_kind)) > 0),
    CONSTRAINT hrm_offers_compensation_amount
      CHECK (compensation_amount > 0),
    CONSTRAINT hrm_offers_compensation_basis
      CHECK (compensation_basis IN ('hourly', 'annual')),
    CONSTRAINT hrm_offers_status
      CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'withdrawn', 'expired')),
    -- A sent offer names when it went out; a responded offer (accepted or
    -- declined) names when; a declined offer names why. One-directional:
    -- an expired offer keeps the sent_at of the sending it expired from.
    CONSTRAINT hrm_offers_sent_paired
      CHECK (status NOT IN ('sent', 'accepted', 'declined') OR sent_at IS NOT NULL),
    CONSTRAINT hrm_offers_responded_paired
      CHECK ((status IN ('accepted', 'declined')) = (responded_at IS NOT NULL)),
    CONSTRAINT hrm_offers_decline_reason
      CHECK ((status = 'declined') = (decline_reason IS NOT NULL AND char_length(btrim(decline_reason)) > 0)),
    CONSTRAINT hrm_offers_approved_change_paired
      CHECK ((status = 'accepted') = (approved_change_id IS NOT NULL)),
    CONSTRAINT hrm_offers_finite_time CHECK (
      proposed_start_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (expires_on IS NULL
        OR expires_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND (sent_at IS NULL
           OR (sent_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND sent_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'))
      AND (responded_at IS NULL
           OR (responded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND responded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

-- ---------------------------------------------------------------------------
-- Covering uniques, keys, indexes. All added defensively (re-runnable).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_templates_pkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_templates ADD CONSTRAINT hrm_pipeline_templates_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_stages_pkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_stages ADD CONSTRAINT hrm_pipeline_stages_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_pkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidates_pkey') THEN
  ALTER TABLE ONLY public.hrm_candidates ADD CONSTRAINT hrm_candidates_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_pkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_pkey') THEN
  ALTER TABLE ONLY public.hrm_application_events ADD CONSTRAINT hrm_application_events_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviews_pkey') THEN
  ALTER TABLE ONLY public.hrm_interviews ADD CONSTRAINT hrm_interviews_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_panel_pkey') THEN
  ALTER TABLE ONLY public.hrm_interview_panel ADD CONSTRAINT hrm_interview_panel_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_pkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_pkey PRIMARY KEY (id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_templates_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_pipeline_templates ADD CONSTRAINT hrm_pipeline_templates_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_stages_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_pipeline_stages ADD CONSTRAINT hrm_pipeline_stages_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidates_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_candidates ADD CONSTRAINT hrm_candidates_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_application_events ADD CONSTRAINT hrm_application_events_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviews_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_interviews ADD CONSTRAINT hrm_interviews_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_panel_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_interview_panel ADD CONSTRAINT hrm_interview_panel_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_templates_org_name') THEN
  ALTER TABLE ONLY public.hrm_pipeline_templates ADD CONSTRAINT hrm_pipeline_templates_org_name
    UNIQUE (org_id, name); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_stages_org_template_position') THEN
  ALTER TABLE ONLY public.hrm_pipeline_stages ADD CONSTRAINT hrm_pipeline_stages_org_template_position
    UNIQUE (org_id, template_id, position); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_stages_org_template_key') THEN
  ALTER TABLE ONLY public.hrm_pipeline_stages ADD CONSTRAINT hrm_pipeline_stages_org_template_key
    UNIQUE (org_id, template_id, key); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_org_number') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_org_number
    UNIQUE (org_id, requisition_number); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_org_requisition_candidate') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_org_requisition_candidate
    UNIQUE (org_id, requisition_id, candidate_id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_panel_org_interview_party') THEN
  ALTER TABLE ONLY public.hrm_interview_panel ADD CONSTRAINT hrm_interview_panel_org_interview_party
    UNIQUE (org_id, interview_id, party_id); END IF; END $$;

-- Exactly one default funnel per org. A second default is a configuration
-- error, not a second default: storage refuses it, the Setup write names it.
CREATE UNIQUE INDEX IF NOT EXISTS hrm_pipeline_templates_one_default_per_org
  ON public.hrm_pipeline_templates (org_id) WHERE is_default;

-- At most one LIVE offer per application (draft or sent): history (accepted,
-- declined, withdrawn, expired rows) accumulates while the open invariant
-- holds race-safe under concurrent writers. A partial unique INDEX, because
-- a UNIQUE constraint cannot carry a WHERE clause.
CREATE UNIQUE INDEX IF NOT EXISTS hrm_offers_one_live_per_application
  ON public.hrm_offers (org_id, application_id) WHERE status IN ('draft', 'sent');

-- Covering unique for the composite approved-change FK below.
-- hrm_employment_change_requests.id is the primary key so (org_id, id)
-- uniqueness already holds; this only names it (0044
-- composite-org-coherence pattern, same as 0193's files covering unique).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_change_requests_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_employment_change_requests ADD CONSTRAINT hrm_employment_change_requests_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

CREATE INDEX IF NOT EXISTS hrm_pipeline_stages_template
  ON public.hrm_pipeline_stages USING btree (org_id, template_id, position);
CREATE INDEX IF NOT EXISTS hrm_requisitions_status
  ON public.hrm_requisitions USING btree (org_id, status);
CREATE INDEX IF NOT EXISTS hrm_requisitions_position
  ON public.hrm_requisitions USING btree (org_id, position_id);
CREATE INDEX IF NOT EXISTS hrm_requisitions_manager
  ON public.hrm_requisitions USING btree (org_id, hiring_manager_party_id);
CREATE INDEX IF NOT EXISTS hrm_candidates_email
  ON public.hrm_candidates USING btree (org_id, lower(email));
CREATE INDEX IF NOT EXISTS hrm_applications_requisition
  ON public.hrm_applications USING btree (org_id, requisition_id, status);
CREATE INDEX IF NOT EXISTS hrm_applications_candidate
  ON public.hrm_applications USING btree (org_id, candidate_id);
CREATE INDEX IF NOT EXISTS hrm_applications_stage
  ON public.hrm_applications USING btree (org_id, stage_id);
CREATE INDEX IF NOT EXISTS hrm_application_events_application
  ON public.hrm_application_events USING btree (org_id, application_id, recorded_at);
CREATE INDEX IF NOT EXISTS hrm_interviews_application
  ON public.hrm_interviews USING btree (org_id, application_id, scheduled_at);
CREATE INDEX IF NOT EXISTS hrm_interviews_upcoming
  ON public.hrm_interviews USING btree (org_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS hrm_interview_panel_interview
  ON public.hrm_interview_panel USING btree (org_id, interview_id);
CREATE INDEX IF NOT EXISTS hrm_offers_application
  ON public.hrm_offers USING btree (org_id, application_id, status);
CREATE INDEX IF NOT EXISTS hrm_offers_expiry
  ON public.hrm_offers USING btree (org_id, status, expires_on);

-- ---------------------------------------------------------------------------
-- Tenant foreign keys (composite org coherence, 0044 pattern). No ON DELETE
-- CASCADE on runtime history: requisitions pin their pipeline (RESTRICT),
-- applications pin their requisition, candidate and stage (RESTRICT), events
-- pin their application (RESTRICT — evidence is never cascade-deleted),
-- interviews pin their application (RESTRICT), panel rows follow their
-- interview (CASCADE, children of a guarded parent), offers pin their
-- application (RESTRICT).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_templates_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_templates ADD CONSTRAINT hrm_pipeline_templates_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_stages_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_stages ADD CONSTRAINT hrm_pipeline_stages_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_stages_template_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_stages ADD CONSTRAINT hrm_pipeline_stages_template_tenant_fkey
    FOREIGN KEY (org_id, template_id) REFERENCES public.hrm_pipeline_templates(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_position_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_position_tenant_fkey
    FOREIGN KEY (org_id, position_id) REFERENCES public.positions(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_employer_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_employer_tenant_fkey
    FOREIGN KEY (org_id, employer_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_department_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_department_tenant_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_location_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_location_tenant_fkey
    FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_manager_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_manager_tenant_fkey
    FOREIGN KEY (org_id, hiring_manager_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_template_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_template_tenant_fkey
    FOREIGN KEY (org_id, pipeline_template_id) REFERENCES public.hrm_pipeline_templates(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidates_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidates ADD CONSTRAINT hrm_candidates_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
-- The hired-party link: set only by hire, and a party merge re-points it
-- through the audited merge path (engine/src/sync/party-merges.ts). No
-- uniqueness involves party_id, so re-pointing cannot duplicate.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidates_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidates ADD CONSTRAINT hrm_candidates_party_tenant_fkey
    FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidates_resume_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidates ADD CONSTRAINT hrm_candidates_resume_tenant_fkey
    FOREIGN KEY (org_id, resume_attachment_id) REFERENCES public.files(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_requisition_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_requisition_tenant_fkey
    FOREIGN KEY (org_id, requisition_id) REFERENCES public.hrm_requisitions(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_candidate_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_candidate_tenant_fkey
    FOREIGN KEY (org_id, candidate_id) REFERENCES public.hrm_candidates(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_stage_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_stage_tenant_fkey
    FOREIGN KEY (org_id, stage_id) REFERENCES public.hrm_pipeline_stages(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_hired_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_hired_employment_tenant_fkey
    FOREIGN KEY (org_id, hired_employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_application_events ADD CONSTRAINT hrm_application_events_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_application_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_application_events ADD CONSTRAINT hrm_application_events_application_tenant_fkey
    FOREIGN KEY (org_id, application_id) REFERENCES public.hrm_applications(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
-- Stage lineage on events: single-column SET NULL (lineage, not scope — the
-- event kind and reason are the record; same-org is proven at append time
-- by the transitioning service, so a cross-org pointer cannot be written).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_from_stage_fkey') THEN
  ALTER TABLE ONLY public.hrm_application_events ADD CONSTRAINT hrm_application_events_from_stage_fkey
    FOREIGN KEY (from_stage_id) REFERENCES public.hrm_pipeline_stages(id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_to_stage_fkey') THEN
  ALTER TABLE ONLY public.hrm_application_events ADD CONSTRAINT hrm_application_events_to_stage_fkey
    FOREIGN KEY (to_stage_id) REFERENCES public.hrm_pipeline_stages(id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviews_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviews ADD CONSTRAINT hrm_interviews_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviews_application_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviews ADD CONSTRAINT hrm_interviews_application_tenant_fkey
    FOREIGN KEY (org_id, application_id) REFERENCES public.hrm_applications(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_panel_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_panel ADD CONSTRAINT hrm_interview_panel_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_panel_interview_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_panel ADD CONSTRAINT hrm_interview_panel_interview_tenant_fkey
    FOREIGN KEY (org_id, interview_id) REFERENCES public.hrm_interviews(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_panel_party_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_panel ADD CONSTRAINT hrm_interview_panel_party_tenant_fkey
    FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_application_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_application_tenant_fkey
    FOREIGN KEY (org_id, application_id) REFERENCES public.hrm_applications(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_position_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_position_tenant_fkey
    FOREIGN KEY (org_id, position_id) REFERENCES public.positions(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_employer_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_employer_tenant_fkey
    FOREIGN KEY (org_id, employer_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_department_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_department_tenant_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_approved_change_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_approved_change_tenant_fkey
    FOREIGN KEY (org_id, approved_change_id) REFERENCES public.hrm_employment_change_requests(org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- Frozen evidence actors (0185 pattern): single-column RESTRICT with no
-- same-org assertion (home-org users), and therefore never nulled.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_application_events_actor_fkey') THEN
  ALTER TABLE ONLY public.hrm_application_events ADD CONSTRAINT hrm_application_events_actor_fkey
    FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_recruiter_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_recruiter_fkey
    FOREIGN KEY (recruiter_user_id) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_templates_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_templates ADD CONSTRAINT hrm_pipeline_templates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_templates_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_templates ADD CONSTRAINT hrm_pipeline_templates_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_stages_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_stages ADD CONSTRAINT hrm_pipeline_stages_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pipeline_stages_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_pipeline_stages ADD CONSTRAINT hrm_pipeline_stages_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_requisitions_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_requisitions ADD CONSTRAINT hrm_requisitions_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidates_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidates ADD CONSTRAINT hrm_candidates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_candidates_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_candidates ADD CONSTRAINT hrm_candidates_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_applications_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_applications ADD CONSTRAINT hrm_applications_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviews_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviews ADD CONSTRAINT hrm_interviews_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interviews_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interviews ADD CONSTRAINT hrm_interviews_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_panel_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_panel ADD CONSTRAINT hrm_interview_panel_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_interview_panel_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_interview_panel ADD CONSTRAINT hrm_interview_panel_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_created_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_offers_updated_by_fkey') THEN
  ALTER TABLE ONLY public.hrm_offers ADD CONSTRAINT hrm_offers_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Storage triggers.
-- ---------------------------------------------------------------------------

-- A pipeline template that opened requisitions is history-pinned: deactivate
-- it with is_active = false instead of deleting it. The RESTRICT FK below
-- is the backstop; this trigger names the remedy (a raw 23503 names nothing).
CREATE OR REPLACE FUNCTION public.hrm_pipeline_template_no_delete()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE live_count integer;
BEGIN
  SELECT count(*)::int INTO live_count FROM public.hrm_requisitions
   WHERE org_id = OLD.org_id AND pipeline_template_id = OLD.id;
  IF live_count > 0 THEN
    RAISE EXCEPTION 'HRM pipeline template % opened % requisition(s) and is retained as history — set is_active = false to retire it instead of deleting it.', OLD.id, live_count
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;

COMMENT ON FUNCTION public.hrm_pipeline_template_no_delete() IS
  'openbooks:hrm_pipeline_template_no_delete:v1 - a template with requisitions is history-pinned; the BEFORE DELETE trigger names the deactivation remedy before the RESTRICT FK fires';

DROP TRIGGER IF EXISTS hrm_pipeline_template_no_delete ON public.hrm_pipeline_templates;
CREATE TRIGGER hrm_pipeline_template_no_delete
  BEFORE DELETE ON public.hrm_pipeline_templates
  FOR EACH ROW EXECUTE FUNCTION public.hrm_pipeline_template_no_delete();

-- The funnel evidence ledger is append-only: an event row is never updated
-- and never deleted on a production path. Deletes are admitted only when
-- openbooks.amend = on (fixture teardown, org wipe — the 0184/0188 house
-- mechanism, never a production path). A fixture that needs no events
-- deletes the application, whose RESTRICT pin refuses while events exist —
-- so event rows go only with the governed wipe, the same standing
-- employment_changes holds.
CREATE OR REPLACE FUNCTION public.hrm_application_events_immutable()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hrm_application_events: funnel events are append-only evidence — they are never deleted'
      USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'hrm_application_events: funnel events are append-only evidence — record a new event instead of editing one'
    USING ERRCODE = '23514';
END $$;

COMMENT ON FUNCTION public.hrm_application_events_immutable() IS
  'openbooks:hrm_application_events_immutable:v1 - funnel events append-only; updates refused on every path, deletes only on the governed amend path';

DROP TRIGGER IF EXISTS hrm_application_events_immutable ON public.hrm_application_events;
CREATE TRIGGER hrm_application_events_immutable
  BEFORE UPDATE OR DELETE ON public.hrm_application_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_application_events_immutable();

-- Runtime history is never deleted on a production path (0184/0188 house
-- mechanism): terminal rows are immutable except a pure audit touch; deletes
-- admitted only when openbooks.amend = on (fixture teardown, org wipe).
CREATE OR REPLACE FUNCTION public.hrm_recruiting_history_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE terminal boolean;
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'hrm_requisitions' THEN
      RAISE EXCEPTION 'hrm_requisitions: openings are retained as history — cancel with a reason instead of deleting them'
        USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'hrm_applications' THEN
      RAISE EXCEPTION 'hrm_applications: candidacies are retained as history — reject or withdraw with a reason instead of deleting them'
        USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'hrm_interviews' THEN
      RAISE EXCEPTION 'hrm_interviews: interviews are retained as history — cancel instead of deleting them'
        USING ERRCODE = '23514';
    ELSE
      RAISE EXCEPTION 'hrm_offers: offers are retained as history — withdraw with a reason instead of deleting them'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  terminal := (OLD.status IN ('rejected', 'withdrawn', 'hired',
                             'completed', 'cancelled', 'no_show',
                             'filled',
                             'accepted', 'declined', 'withdrawn', 'expired'));
  IF terminal
     AND to_jsonb(NEW) - ARRAY['updated_at','updated_by']
       <> to_jsonb(OLD) - ARRAY['updated_at','updated_by'] THEN
    RAISE EXCEPTION '%.%: a % row is terminal and immutable — open a new row for further work', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.hrm_recruiting_history_guard() IS
  'openbooks:hrm_recruiting_history_guard:v1 - terminal applications, interviews and offers immutable except a pure audit touch; deletes only on the governed amend path';

DROP TRIGGER IF EXISTS hrm_requisitions_history ON public.hrm_requisitions;
CREATE TRIGGER hrm_requisitions_history
  BEFORE UPDATE OR DELETE ON public.hrm_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.hrm_recruiting_history_guard();
DROP TRIGGER IF EXISTS hrm_applications_history ON public.hrm_applications;
CREATE TRIGGER hrm_applications_history
  BEFORE UPDATE OR DELETE ON public.hrm_applications
  FOR EACH ROW EXECUTE FUNCTION public.hrm_recruiting_history_guard();
DROP TRIGGER IF EXISTS hrm_interviews_history ON public.hrm_interviews;
CREATE TRIGGER hrm_interviews_history
  BEFORE UPDATE OR DELETE ON public.hrm_interviews
  FOR EACH ROW EXECUTE FUNCTION public.hrm_recruiting_history_guard();
DROP TRIGGER IF EXISTS hrm_offers_history ON public.hrm_offers;
CREATE TRIGGER hrm_offers_history
  BEFORE UPDATE OR DELETE ON public.hrm_offers
  FOR EACH ROW EXECUTE FUNCTION public.hrm_recruiting_history_guard();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0177/0181 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all nine tables. HRM stays out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_pipeline_templates', 'hrm_pipeline_stages',
    'hrm_requisitions', 'hrm_candidates', 'hrm_applications',
    'hrm_application_events', 'hrm_interviews', 'hrm_interview_panel',
    'hrm_offers'] LOOP
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

COMMENT ON TABLE public.hrm_pipeline_templates IS
  'HRM recruiting funnels (0195): one ordered pipeline per org name with a single default. Deactivation preserves history; a template that opened requisitions cannot be deleted.';
COMMENT ON TABLE public.hrm_pipeline_stages IS
  'HRM pipeline rows (0195): ordered stages with a stable key and a kind (screening, interview, assessment, offer, hired, rejected). Terminality derives from kind; the funnel ends exactly in hired or rejected.';
COMMENT ON TABLE public.hrm_requisitions IS
  'HRM vacancy openings (0195): one row per vacancy against a position or a planned headcount, with an org-sequence number, headcount versus filled_count (filled only through hire), an all-or-nothing compensation triple, and an aggregate concurrency revision. Deletes only on the governed amend path.';
COMMENT ON TABLE public.hrm_candidates IS
  'HRM prospects (0195): a name plus contact PII, never a party until hired — the hire transaction links the employee party. Contact PII is masked in sandboxes like parties.';
COMMENT ON TABLE public.hrm_applications IS
  'HRM candidacies (0195): one row per (requisition, candidate) with the current pipeline stage. Terminal rows immutable; deletes only on the governed amend path.';
COMMENT ON TABLE public.hrm_application_events IS
  'HRM funnel evidence (0195): the append-only event ledger for every application transition, recorded in the same transaction as the state write. Updates refused on every path; deletes only on the governed amend path.';
COMMENT ON TABLE public.hrm_interviews IS
  'HRM interview sittings (0195): one row per interview with kind, schedule, outcome on completion, and optional scorecard. Completed rows immutable; deletes only on the governed amend path.';
COMMENT ON TABLE public.hrm_interview_panel IS
  'HRM interview panel membership (0195): join rows between interviews and parties, children of a guarded parent (cascade with the interview).';
COMMENT ON TABLE public.hrm_offers IS
  'HRM proposed terms (0195): at most one live offer per application (partial unique index), with send/respond evidence and the hire change request link. Terminal rows immutable; deletes only on the governed amend path.';
