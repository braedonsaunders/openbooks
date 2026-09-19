-- OpenBooks forward migration 0184_hrm_employment_foundation.
--
-- Additive HRM employment foundation on native parties (worker) and
-- subsidiaries (legal employer). Scope of THIS file: six HRM tables with
-- storage-level invariants (constraints, exclusions, triggers, RLS) and no
-- reads or writes from any product path. It alters no payroll table and
-- performs no backfill; consumer behavior (canonical reads/writes,
-- one-time data-preserving migration) is implemented and guaranteed
-- elsewhere, not asserted here.
--
-- Stable identity is separated from append-preserved versions:
--   worker_employments / employment_assignments are stable identity rows.
--   worker_employment_versions / employment_assignment_versions /
--   reporting_relationships carry half-open [effective_from, effective_to)
--   AND [recorded_at, recorded_until) intervals. effective_from and
--   recorded_at are NOT NULL: a backfill asserts CURRENT observed state
--   starting at the observation date and never claims an original hire
--   date. Unknown historical starts live in the nullable
--   service_start/service_start_provenance pair, never as fake dates and
--   never mapped to -infinity (no '-infinity' appears in this file).
--   employment_changes rows are immutable evidence.
-- Every enforcement below is storage-level (constraints, exclusions,
-- triggers, RLS): the canonical service is the operator, never the guard.
-- HRM tables are confidential: this migration does NOT expose them to the
-- generic governed-query catalog (no openbooks_refresh_query_catalog call).
--
-- CANONICAL EMPLOYER, NO LEGACY PROJECTION: worker_employments.employer
-- is the single employer of record; there is no parallel legacy master and
-- no gated cutover. This migration performs NO backfill and NO activation:
-- source rows whose employer or start date is ambiguous are refused by the
-- one-time data-preserving migration (parent integration), never fabricated
-- here. A legacy null subsidiary means UNKNOWN, never the org root. This
-- file changes no employee_roles row, parties flag, or payroll input.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- UUID equality operator classes for the GiST exclusion constraints below.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- Per-org reporting-graph revision: the cycle guard bumps this row on every
-- reporting write BEFORE walking, which serializes concurrent writers on
-- the row lock and turns a stale snapshot into a 40001 serialization
-- failure (fail closed) under REPEATABLE READ or higher. Advisory locks
-- alone cannot do this: a snapshot established before the trigger stays
-- stale no matter what lock is taken inside it.
CREATE TABLE IF NOT EXISTS public.hrm_graph_revisions (
    org_id uuid NOT NULL,
    rev bigint NOT NULL DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_graph_revisions_pkey') THEN
  ALTER TABLE ONLY public.hrm_graph_revisions ADD CONSTRAINT hrm_graph_revisions_pkey PRIMARY KEY (org_id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_graph_revisions_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_graph_revisions ADD CONSTRAINT hrm_graph_revisions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;

COMMENT ON TABLE public.hrm_graph_revisions IS
  'HRM reporting-graph serialization counter (0184): bumped by hrm_reporting_no_cycle on every reporting write before the cycle walk. Storage-only concurrency mechanism, never product data.';

-- FINITE CIVIL TIME (reader/storage contract): the engine admits only finite
-- AD civil dates 0001-01-01..9999-12-31 and UTC stamps in the same years.
-- PostgreSQL date/timestamptz also admit infinity, BC, and year > 9999,
-- which the reader refuses -- so what the reader cannot observe must not be
-- savable. NULL alone means unbounded; every non-null bound below is pinned
-- to the supported range with one shared shape per table.

-- ---------------------------------------------------------------------------
-- Tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.worker_employments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    worker_party_id uuid NOT NULL,
    employer_subsidiary_id uuid NOT NULL,
    employment_number text,
    -- Aggregate concurrency revision, bumped by exactly one on ANY change
    -- under this employment (worker_employment_versions,
    -- employment_assignment_versions, reporting_relationships).
    revision integer NOT NULL DEFAULT 1,
    -- Original hire/service start when actually known; null = unknown.
    -- Provenance names the source. Backfill asserts current observed state
    -- from the observation date only (worker_employments_service_start).
    service_start date,
    service_start_provenance text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT worker_employments_revision CHECK (revision >= 1),
    -- Three-valued-logic note: the NOT NULL arms are explicit because a
    -- NULL operand would make the comparison NULL (not false) and CHECK
    -- would wrongly pass.
    CONSTRAINT worker_employments_service_start CHECK (
      (service_start IS NULL AND service_start_provenance IS NULL)
      OR (service_start IS NOT NULL AND service_start_provenance IS NOT NULL
          AND char_length(btrim(service_start_provenance)) > 0)
    ),
    CONSTRAINT worker_employments_finite_time CHECK (
      service_start IS NULL
      OR service_start BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    )
);

CREATE TABLE IF NOT EXISTS public.worker_employment_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    version_no integer NOT NULL,
    status text NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_until timestamp with time zone,
    -- Version closing this one (null = live). Always names a real
    -- version_no of the same employment (closure guards verify).
    -- Link to the ONE aggregate employment_changes event evidencing this
    -- closure (null = live). Several versions closed in one operation share
    -- one event; composite FK to employment_changes(org_id, id) below.
    closed_by_change_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT worker_employment_versions_status
      CHECK (status IN ('offered', 'active', 'on_leave', 'suspended', 'terminated')),
    CONSTRAINT worker_employment_versions_range
      CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT worker_employment_versions_recorded
      CHECK (recorded_until IS NULL OR recorded_until > recorded_at),
    CONSTRAINT worker_employment_versions_no CHECK (version_no >= 1),
    CONSTRAINT worker_employment_versions_closure
      CHECK ((superseded_by IS NULL) = (recorded_until IS NULL)
      AND (superseded_by IS NULL) = (closed_by_change_id IS NULL)),
    CONSTRAINT worker_employment_versions_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL
           OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND (recorded_until IS NULL
           OR (recorded_until >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND recorded_until < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

CREATE TABLE IF NOT EXISTS public.employment_assignments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    assignment_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT employment_assignments_key_not_blank
      CHECK (char_length(btrim(assignment_key)) > 0)
);

CREATE TABLE IF NOT EXISTS public.employment_assignment_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    assignment_id uuid NOT NULL,
    -- Denormalized for the per-employment primary exclusion; proven to
    -- match the assignment's employment by
    -- employment_assignment_versions_employment_guard.
    employment_id uuid NOT NULL,
    version_no integer NOT NULL,
    job_title text,
    department_id uuid,
    location_id uuid,
    fte numeric(7, 4) NOT NULL DEFAULT 1,
    -- Effective-dated: true only while this slot is the primary one.
    is_primary boolean NOT NULL DEFAULT false,
    effective_from date NOT NULL,
    effective_to date,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_until timestamp with time zone,
    -- Link to the ONE aggregate employment_changes event evidencing this
    -- closure (null = live). Several versions closed in one operation share
    -- one event; composite FK to employment_changes(org_id, id) below.
    closed_by_change_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT employment_assignment_versions_range
      CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT employment_assignment_versions_recorded
      CHECK (recorded_until IS NULL OR recorded_until > recorded_at),
    CONSTRAINT employment_assignment_versions_no CHECK (version_no >= 1),
    CONSTRAINT employment_assignment_versions_closure
      CHECK ((superseded_by IS NULL) = (recorded_until IS NULL)
      AND (superseded_by IS NULL) = (closed_by_change_id IS NULL)),
    CONSTRAINT employment_assignment_versions_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL
           OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND (recorded_until IS NULL
           OR (recorded_until >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND recorded_until < TIMESTAMPTZ '10000-01-01 00:00:00+00'))),
    -- NaN note: PostgreSQL numeric NaN sorts ABOVE ordinary numbers, so
    -- fte > 0 alone accepts NaN; the explicit != 'NaN' rejects it (NaN =
    -- NaN is true in PG, so != yields false and CHECK fails).
    CONSTRAINT employment_assignment_versions_fte CHECK (fte > 0 AND fte != 'NaN')
);

CREATE TABLE IF NOT EXISTS public.employment_changes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    assignment_id uuid,
    revision integer NOT NULL,
    supersedes_id uuid,
    change_kind text NOT NULL,
    prior_snapshot jsonb NOT NULL,
    reason text NOT NULL,
    recorded_source text NOT NULL DEFAULT 'user',
    -- User actor (employment_changes_recorded_by_fkey, never nulled by
    -- user deletion so evidence stays attributable); null for system
    -- actors, which instead name recorded_source_ref.
    recorded_by uuid,
    -- The autonomous process or job, e.g. 'party-merge <run id>'.
    recorded_source_ref text,
    -- Immutable transaction stamp, ALWAYS set by
    -- employment_changes_stamp_txid (the service never supplies it):
    -- the top-level transaction that wrote this event. Closure proof
    -- compares it with txid_current(), never timestamps.
    change_txid bigint NOT NULL,
    -- Exact closed-version/before-image array for closures closed under
    -- this ONE aggregate change (status + several assignment corrections in
    -- one operation share one event): every element names
    -- {table, identity, version_no, row_id} plus the row's before image.
    -- Empty array for non-closure events. Proven deferred in
    -- hrm_closure_evidence_guard against the linked version rows.
    closed_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT employment_changes_kind CHECK (change_kind IN
      ('created', 'status_changed', 'assignment_issued',
       'assignment_superseded', 'corrected', 'terminated',
       'rehired_reference')),
    CONSTRAINT employment_changes_revision CHECK (revision >= 1),
    CONSTRAINT employment_changes_reason
      CHECK (char_length(btrim(reason)) > 0),
    CONSTRAINT employment_changes_snapshot
      CHECK (jsonb_typeof(prior_snapshot) = 'object'),
    -- Three-valued-logic note: recorded_source_ref IS NOT NULL is
    -- explicit because btrim(NULL) yields NULL (not false) and CHECK would
    -- wrongly pass a system actor with no named source.
    CONSTRAINT employment_changes_actor CHECK (
      (recorded_source = 'user' AND recorded_by IS NOT NULL
       AND recorded_source_ref IS NULL)
      OR (recorded_source = 'system' AND recorded_by IS NULL
          AND recorded_source_ref IS NOT NULL
          AND char_length(btrim(recorded_source_ref)) > 0)),
    CONSTRAINT employment_changes_closed_versions
      CHECK (jsonb_typeof(closed_versions) = 'array'),
    CONSTRAINT employment_changes_finite_time CHECK (
      recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
    )
);

CREATE TABLE IF NOT EXISTS public.reporting_relationships (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    manager_employment_id uuid NOT NULL,
    kind text NOT NULL DEFAULT 'line',
    -- Stable relationship identity across manager changes: every version of
    -- one subordinate's LINE shares one id; each MATRIX edge owns a fresh
    -- id. superseded_by chains within this id.
    relationship_id uuid NOT NULL,
    version_no integer NOT NULL DEFAULT 1,
    effective_from date NOT NULL,
    effective_to date,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_until timestamp with time zone,
    -- Link to the ONE aggregate employment_changes event evidencing this
    -- closure (null = live). Several versions closed in one operation share
    -- one event; composite FK to employment_changes(org_id, id) below.
    closed_by_change_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT reporting_relationships_kind CHECK (kind IN ('line', 'matrix')),
    CONSTRAINT reporting_relationships_no_self
      CHECK (manager_employment_id <> employment_id),
    CONSTRAINT reporting_relationships_range
      CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT reporting_relationships_recorded
      CHECK (recorded_until IS NULL OR recorded_until > recorded_at),
    CONSTRAINT reporting_relationships_no CHECK (version_no >= 1),
    CONSTRAINT reporting_relationships_closure
      CHECK ((superseded_by IS NULL) = (recorded_until IS NULL)
      AND (superseded_by IS NULL) = (closed_by_change_id IS NULL)),
    CONSTRAINT reporting_relationships_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL
           OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND (recorded_until IS NULL
           OR (recorded_until >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND recorded_until < TIMESTAMPTZ '10000-01-01 00:00:00+00')))
);

-- ---------------------------------------------------------------------------
-- Primary keys, unique keys, indexes. All added defensively (re-runnable).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employments_pkey') THEN
  ALTER TABLE ONLY public.worker_employments ADD CONSTRAINT worker_employments_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employment_versions_pkey') THEN
  ALTER TABLE ONLY public.worker_employment_versions ADD CONSTRAINT worker_employment_versions_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignments_pkey') THEN
  ALTER TABLE ONLY public.employment_assignments ADD CONSTRAINT employment_assignments_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_pkey') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_pkey') THEN
  ALTER TABLE ONLY public.employment_changes ADD CONSTRAINT employment_changes_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reporting_relationships_pkey') THEN
  ALTER TABLE ONLY public.reporting_relationships ADD CONSTRAINT reporting_relationships_pkey PRIMARY KEY (id); END IF; END $$;

-- Covering (org_id, id) uniques: the composite tenant FKs below need them.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employments_org_id_id_unique') THEN
  ALTER TABLE ONLY public.worker_employments ADD CONSTRAINT worker_employments_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employment_versions_org_id_id_unique') THEN
  ALTER TABLE ONLY public.worker_employment_versions ADD CONSTRAINT worker_employment_versions_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignments_org_id_id_unique') THEN
  ALTER TABLE ONLY public.employment_assignments ADD CONSTRAINT employment_assignments_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_org_id_id_unique') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_org_id_id_unique') THEN
  ALTER TABLE ONLY public.employment_changes ADD CONSTRAINT employment_changes_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reporting_relationships_org_id_id_unique') THEN
  ALTER TABLE ONLY public.reporting_relationships ADD CONSTRAINT reporting_relationships_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- One employment_number per legal employer. Partial index (null numbers
-- never conflict); there is deliberately no table constraint here, because
-- a Unique NULLS NOT DISTINCT would wrongly unify null numbers.
--
-- UNIQUENESS INVENTORY for worker_employments (merge-owner requirement):
-- the ONLY uniqueness on this table is (1) the PK on id, (2) the covering
-- (org_id, id), and (3) this partial index on
-- (org_id, employer_subsidiary_id, employment_number). NONE involves
-- worker_party_id, which is exactly why the native party merge may move
-- that column wholesale (SIMPLE entry in engine/src/sync/party-merges.ts).
-- ADDING any unique or partial-unique key involving worker_party_id (e.g.
-- "one current employment per worker") INVALIDATES that entry: re-derive
-- the merge policy first or merges will silently collapse employments.
DROP INDEX IF EXISTS public.worker_employments_org_employer_number_nn;
CREATE UNIQUE INDEX IF NOT EXISTS worker_employments_org_employer_number_nn
  ON public.worker_employments (org_id, employer_subsidiary_id, employment_number)
  WHERE employment_number IS NOT NULL;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employment_versions_employment_no') THEN
  ALTER TABLE ONLY public.worker_employment_versions ADD CONSTRAINT worker_employment_versions_employment_no
    UNIQUE (org_id, employment_id, version_no); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignments_employment_key') THEN
  ALTER TABLE ONLY public.employment_assignments ADD CONSTRAINT employment_assignments_employment_key
    UNIQUE (org_id, employment_id, assignment_key); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_assignment_no') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_assignment_no
    UNIQUE (org_id, assignment_id, version_no); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_employment_revision') THEN
  ALTER TABLE ONLY public.employment_changes ADD CONSTRAINT employment_changes_employment_revision
    UNIQUE (org_id, employment_id, revision); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reporting_relationships_line_version') THEN
  ALTER TABLE ONLY public.reporting_relationships ADD CONSTRAINT reporting_relationships_line_version
    UNIQUE (org_id, relationship_id, version_no); END IF; END $$;

CREATE INDEX IF NOT EXISTS worker_employments_worker ON public.worker_employments USING btree (org_id, worker_party_id);
CREATE INDEX IF NOT EXISTS worker_employments_employer ON public.worker_employments USING btree (org_id, employer_subsidiary_id);
CREATE INDEX IF NOT EXISTS worker_employment_versions_employment ON public.worker_employment_versions USING btree (org_id, employment_id, effective_from);
CREATE INDEX IF NOT EXISTS employment_assignments_employment ON public.employment_assignments USING btree (org_id, employment_id);
CREATE INDEX IF NOT EXISTS employment_assignment_versions_assignment ON public.employment_assignment_versions USING btree (org_id, assignment_id, effective_from);
CREATE INDEX IF NOT EXISTS employment_assignment_versions_employment ON public.employment_assignment_versions USING btree (org_id, employment_id, effective_from);
CREATE INDEX IF NOT EXISTS employment_changes_employment ON public.employment_changes USING btree (org_id, employment_id, revision);
CREATE INDEX IF NOT EXISTS reporting_relationships_employment ON public.reporting_relationships USING btree (org_id, employment_id, effective_from);
CREATE INDEX IF NOT EXISTS reporting_relationships_manager ON public.reporting_relationships USING btree (org_id, manager_employment_id);
CREATE INDEX IF NOT EXISTS reporting_relationships_relationship ON public.reporting_relationships USING btree (org_id, relationship_id);

-- ---------------------------------------------------------------------------
-- Tenant foreign keys (composite org coherence, 0044 pattern). No ON DELETE
-- CASCADE on employment history: deletes are RESTRICTed (NO ACTION default);
-- history is retired via version closure, never deleted.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employments_org_id_fkey') THEN
  ALTER TABLE ONLY public.worker_employments ADD CONSTRAINT worker_employments_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employments_worker_tenant_fkey') THEN
  ALTER TABLE ONLY public.worker_employments ADD CONSTRAINT worker_employments_worker_tenant_fkey
    FOREIGN KEY (org_id, worker_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employments_employer_tenant_fkey') THEN
  ALTER TABLE ONLY public.worker_employments ADD CONSTRAINT worker_employments_employer_tenant_fkey
    FOREIGN KEY (org_id, employer_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employment_versions_org_id_fkey') THEN
  ALTER TABLE ONLY public.worker_employment_versions ADD CONSTRAINT worker_employment_versions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employment_versions_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.worker_employment_versions ADD CONSTRAINT worker_employment_versions_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignments_org_id_fkey') THEN
  ALTER TABLE ONLY public.employment_assignments ADD CONSTRAINT employment_assignments_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignments_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_assignments ADD CONSTRAINT employment_assignments_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_org_id_fkey') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_assignment_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_assignment_tenant_fkey
    FOREIGN KEY (org_id, assignment_id) REFERENCES public.employment_assignments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_department_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_department_tenant_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_location_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_location_tenant_fkey
    FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_org_id_fkey') THEN
  ALTER TABLE ONLY public.employment_changes ADD CONSTRAINT employment_changes_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_changes ADD CONSTRAINT employment_changes_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_assignment_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_changes ADD CONSTRAINT employment_changes_assignment_tenant_fkey
    FOREIGN KEY (org_id, assignment_id) REFERENCES public.employment_assignments(org_id, id) DEFERRABLE; END IF; END $$;
-- Closure links point at the immutable aggregate event (same org enforced).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employment_versions_change_tenant_fkey') THEN
  ALTER TABLE ONLY public.worker_employment_versions ADD CONSTRAINT worker_employment_versions_change_tenant_fkey
    FOREIGN KEY (org_id, closed_by_change_id) REFERENCES public.employment_changes(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_change_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_change_tenant_fkey
    FOREIGN KEY (org_id, closed_by_change_id) REFERENCES public.employment_changes(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reporting_relationships_change_tenant_fkey') THEN
  ALTER TABLE ONLY public.reporting_relationships ADD CONSTRAINT reporting_relationships_change_tenant_fkey
    FOREIGN KEY (org_id, closed_by_change_id) REFERENCES public.employment_changes(org_id, id) DEFERRABLE; END IF; END $$;
-- The evidence actor must stay a real user row: NO ACTION (never nulled by
-- user deletion; deactivate users instead). House created_by/updated_by
-- columns follow the 0181 SET NULL precedent.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_changes_recorded_by_fkey') THEN
  ALTER TABLE ONLY public.employment_changes ADD CONSTRAINT employment_changes_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES public.users(id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reporting_relationships_org_id_fkey') THEN
  ALTER TABLE ONLY public.reporting_relationships ADD CONSTRAINT reporting_relationships_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reporting_relationships_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.reporting_relationships ADD CONSTRAINT reporting_relationships_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reporting_relationships_manager_tenant_fkey') THEN
  ALTER TABLE ONLY public.reporting_relationships ADD CONSTRAINT reporting_relationships_manager_tenant_fkey
    FOREIGN KEY (org_id, manager_employment_id) REFERENCES public.worker_employments(org_id, id) DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- GiST exclusion constraints (0051 pattern): race-safe under concurrent
-- READ COMMITTED writers, where BEFORE triggers go blind. Half-open '[)'
-- ranges: adjacent [a,b)+[b,c) do NOT overlap (temporal contract).
-- No '-infinity': effective_from is NOT NULL; only the unbounded end maps
-- to 'infinity', in SQL only (engine/TS stays null).
--
-- Service write order matters: CLOSE the old version (recorded_until +
-- superseded_by) BEFORE INSERTing its successor in the same transaction.
-- The successor's recorded window starts exactly where the old one ends,
-- so close-first never triple-overlaps; insert-first would (correctly)
-- fail against the still-open predecessor.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_employment_versions_no_overlap') THEN
  ALTER TABLE ONLY public.worker_employment_versions ADD CONSTRAINT worker_employment_versions_no_overlap
    EXCLUDE USING gist (
      employment_id WITH =,
      daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&,
      tstzrange(recorded_at, COALESCE(recorded_until, 'infinity'::timestamptz), '[)') WITH &&
    ) DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_no_overlap') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_no_overlap
    EXCLUDE USING gist (
      assignment_id WITH =,
      daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&,
      tstzrange(recorded_at, COALESCE(recorded_until, 'infinity'::timestamptz), '[)') WITH &&
    ) DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- At most one primary version per employment at any (effective, recorded)
-- point. Primary reassignment over time = versions disjoint in at least one
-- dimension (temporal contract: disjoint effective slices may share recorded
-- windows; seamless recorded handoff of identical effective windows passes).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_single_primary') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_single_primary
    EXCLUDE USING gist (
      employment_id WITH =,
      daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&,
      tstzrange(recorded_at, COALESCE(recorded_until, 'infinity'::timestamptz), '[)') WITH &&
    ) WHERE (is_primary) DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- At most one line version per subordinate at any (effective, recorded)
-- point. Matrix lines are simultaneous and unconstrained by design.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reporting_relationships_single_line') THEN
  ALTER TABLE ONLY public.reporting_relationships ADD CONSTRAINT reporting_relationships_single_line
    EXCLUDE USING gist (
      employment_id WITH =,
      daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&,
      tstzrange(recorded_at, COALESCE(recorded_until, 'infinity'::timestamptz), '[)') WITH &&
    ) WHERE (kind = 'line') DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Storage triggers.
-- ---------------------------------------------------------------------------

-- Employer identity is immutable; worker remap ONLY through the audited
-- native party merge (engine/src/sync/party-merges.ts), verified against
-- the absorbed party's merged_into marker. A merge never reassigns the
-- employer: this function has no path that changes employer_subsidiary_id.
--
-- DEFERRED to transaction end on purpose: applyMergeTx re-points party
-- references BEFORE writing parties.custom.merged_into in the same
-- transaction, so an immediate check would see the marker missing and break
-- every native merge. At commit the marker is present; a remap without one
-- rolls the whole transaction back. Honest scope: this proves the remap
-- target equals the recorded merge survivor (authorization by recorded
-- outcome). It does NOT prove this transaction performed the merge, and it
-- does not read the merge audit row (whose shape is the merge module's
-- internal detail, not a stable contract).
CREATE OR REPLACE FUNCTION public.worker_employments_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE survivor uuid;
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'worker_employments: org_id is immutable (composite children reference it)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.employer_subsidiary_id IS DISTINCT FROM OLD.employer_subsidiary_id THEN
    RAISE EXCEPTION 'worker_employments: employer_subsidiary_id is immutable (transfer = terminate + rehire, never an edit)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.worker_party_id IS DISTINCT FROM OLD.worker_party_id THEN
    -- The marker is the WHOLE contract (merge-owner guarantee): the
    -- absorbed party carries custom.merged_into.survivor, written inside
    -- the merge transaction with the absorbed row deactivated, never
    -- deleted. Deliberately NOT the audit_log row: audit shape is the merge
    -- module's internal detail, and gating a data constraint on a
    -- compliance artifact would couple this table to that shape forever.
    SELECT (custom->'merged_into'->>'survivor')::uuid INTO survivor
      FROM public.parties WHERE id = OLD.worker_party_id AND org_id = OLD.org_id;
    IF survivor IS DISTINCT FROM NEW.worker_party_id THEN
      RAISE EXCEPTION 'worker_employments: worker_party_id changes only through the audited native party merge (engine/src/sync/party-merges.ts)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.worker_employments_identity_guard() IS
  'openbooks:worker_employments_identity_guard:v1 - org/employer immutable; worker remap only to the recorded merge survivor (marker), validated deferred at commit. Honest scope: proves the target matches a recorded merge outcome, not that this transaction performed the merge';

DROP TRIGGER IF EXISTS worker_employments_identity ON public.worker_employments;
CREATE CONSTRAINT TRIGGER worker_employments_identity
  AFTER UPDATE ON public.worker_employments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.worker_employments_identity_guard();

-- Assignment slots are stable identity: org and parent employment can never
-- change after versions exist, or the same-employment proofs in
-- employment_assignment_versions_employment_guard and
-- employment_changes_provenance_guard would validate against a moved row.
-- (Composite FKs are ON UPDATE NO ACTION, which only blocks the parent
-- side; this pins the child side.)
CREATE OR REPLACE FUNCTION public.employment_assignments_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id THEN
    RAISE EXCEPTION 'employment_assignments: org_id and employment_id are immutable (close the slot and open a new one, never move it)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.employment_assignments_identity_guard() IS
  'openbooks:employment_assignments_identity_guard:v1 - stable slot identity; parent keys immutable so version provenance proofs cannot be invalidated';

DROP TRIGGER IF EXISTS employment_assignments_identity ON public.employment_assignments;
CREATE TRIGGER employment_assignments_identity
  BEFORE UPDATE ON public.employment_assignments
  FOR EACH ROW EXECUTE FUNCTION public.employment_assignments_identity_guard();

-- Controlled version closure: closed rows are immutable; the ONLY allowed
-- UPDATE on a live row is the closing transition (sets recorded_until +
-- superseded_by, touches nothing else); the new version_no must already
-- exist for the same identity (no dangling superseded_by pointers).
-- Deletes are rejected: retire via closure, never DELETE.
CREATE OR REPLACE FUNCTION public.worker_employment_versions_closure_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  -- Governed amend path (fixture teardown, historical replay, native merge):
  -- the existing house mechanism, not a new bypass. Production paths never
  -- set openbooks.amend; scratch teardown does, or cascade deletes of a
  -- dropped scratch org could never complete.
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'worker_employment_versions: rows are never deleted; close with a superseding version'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'worker_employment_versions: closed versions are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by IS NULL OR NEW.recorded_until IS NULL THEN
    RAISE EXCEPTION 'worker_employment_versions: live rows are append-only; the only allowed UPDATE is the closing transition (recorded_until + superseded_by)'
      USING ERRCODE = '23514';
  END IF;
  -- Explicit allowlist: ONLY recorded_until, superseded_by, closed_by_change_id, and the audit
  -- touch (updated_at/updated_by) may differ. Identity, content, effective
  -- and recorded starts, and creation audit can never mutate. The successor
  -- reference and its evidence are validated deferred at commit
  -- (hrm_closure_evidence_guard), because the successor row and its
  -- employment_changes event are written AFTER the close in the same
  -- transaction (close-then-insert-then-evidence).
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'worker_employment_versions: closure sets recorded_until + superseded_by + closed_by_change_id (plus audit touch) only'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.worker_employment_versions_closure_guard() IS
  'openbooks:worker_employment_versions_closure_guard:v1 - closed rows immutable; live rows accept only the closing transition; successor + evidence proven deferred by hrm_closure_evidence_guard';

DROP TRIGGER IF EXISTS worker_employment_versions_closure ON public.worker_employment_versions;
CREATE TRIGGER worker_employment_versions_closure
  BEFORE UPDATE OR DELETE ON public.worker_employment_versions
  FOR EACH ROW EXECUTE FUNCTION public.worker_employment_versions_closure_guard();

CREATE OR REPLACE FUNCTION public.employment_assignment_versions_closure_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  -- Governed amend path (fixture teardown, historical replay, native merge):
  -- the existing house mechanism, not a new bypass. Production paths never
  -- set openbooks.amend; scratch teardown does, or cascade deletes of a
  -- dropped scratch org could never complete.
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employment_assignment_versions: rows are never deleted; close with a superseding version'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'employment_assignment_versions: closed versions are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by IS NULL OR NEW.recorded_until IS NULL THEN
    RAISE EXCEPTION 'employment_assignment_versions: live rows are append-only; the only allowed UPDATE is the closing transition (recorded_until + superseded_by)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.job_title IS DISTINCT FROM OLD.job_title
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.fte IS DISTINCT FROM OLD.fte
     OR NEW.is_primary IS DISTINCT FROM OLD.is_primary
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'employment_assignment_versions: closure sets recorded_until + superseded_by + closed_by_change_id (plus audit touch) only'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.employment_assignment_versions_closure_guard() IS
  'openbooks:employment_assignment_versions_closure_guard:v1 - closed rows immutable; live rows accept only the closing transition; successor + evidence proven deferred by hrm_closure_evidence_guard';

DROP TRIGGER IF EXISTS employment_assignment_versions_closure ON public.employment_assignment_versions;
CREATE TRIGGER employment_assignment_versions_closure
  BEFORE UPDATE OR DELETE ON public.employment_assignment_versions
  FOR EACH ROW EXECUTE FUNCTION public.employment_assignment_versions_closure_guard();

CREATE OR REPLACE FUNCTION public.reporting_relationships_closure_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  -- Governed amend path (fixture teardown, historical replay, native merge):
  -- the existing house mechanism, not a new bypass. Production paths never
  -- set openbooks.amend; scratch teardown does, or cascade deletes of a
  -- dropped scratch org could never complete.
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reporting_relationships: rows are never deleted; close with a superseding version'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'reporting_relationships: closed rows are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by IS NULL OR NEW.recorded_until IS NULL THEN
    RAISE EXCEPTION 'reporting_relationships: live rows are append-only; the only allowed UPDATE is the closing transition (recorded_until + superseded_by)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.manager_employment_id IS DISTINCT FROM OLD.manager_employment_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.relationship_id IS DISTINCT FROM OLD.relationship_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'reporting_relationships: closure sets recorded_until + superseded_by + closed_by_change_id (plus audit touch) only'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.reporting_relationships_closure_guard() IS
  'openbooks:reporting_relationships_closure_guard:v1 - closed rows immutable; live rows accept only the closing transition; successor + evidence proven deferred by hrm_closure_evidence_guard';

DROP TRIGGER IF EXISTS reporting_relationships_closure ON public.reporting_relationships;
CREATE TRIGGER reporting_relationships_closure
  BEFORE UPDATE OR DELETE ON public.reporting_relationships
  FOR EACH ROW EXECUTE FUNCTION public.reporting_relationships_closure_guard();

-- Deferred closure proof: every version closed in a transaction must link
-- (closed_by_change_id) an employment_changes event of the SAME employment
-- that (a) was written in THIS transaction (change_txid = txid_current(),
-- stamped immutable at insert, never supplied by the service), and (b)
-- names this exact closure in its closed_versions array. The successor must
-- be strictly newer (rejects self and backwards: no recursive walker
-- needed, version_no increase plus adjacency is the whole proof) and start
-- exactly where the closed row ends (seamless handoff). Deferred because
-- close/insert/evidence commit in one transaction in any order, and one
-- aggregate change may close SEVERAL versions (status + assignment
-- corrections) under a single event: each linked row is proven, and the
-- event's array must contain every one of them. TG_ARGV[0] is the version
-- chain's identity column.
CREATE OR REPLACE FUNCTION public.hrm_closure_evidence_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  identity_col text := TG_ARGV[0];
  idcol_val uuid;
  ev_txid bigint;
  ev_array jsonb;
  succ_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.superseded_by IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.closed_by_change_id IS NULL THEN
    RAISE EXCEPTION '%: closing a version requires closed_by_change_id (the aggregate evidence event)', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF identity_col = 'employment_id' THEN
    idcol_val := NEW.employment_id;
  ELSIF identity_col = 'assignment_id' THEN
    idcol_val := NEW.assignment_id;
  ELSE
    idcol_val := NEW.relationship_id;
  END IF;
  -- Real adjacent successor: exists, strictly newer, starts exactly here.
  EXECUTE format(
    'SELECT recorded_at FROM public.%I WHERE org_id = $1 AND %I = $2 AND version_no = $3',
    TG_TABLE_NAME, identity_col)
    INTO succ_at
    USING NEW.org_id, idcol_val, NEW.superseded_by;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%: superseded_by must name a real version_no of the same identity (no dangling pointers)', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by <= NEW.version_no THEN
    RAISE EXCEPTION '%: successor version_no must be strictly newer (rejects self and backwards)', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF succ_at IS DISTINCT FROM NEW.recorded_until THEN
    RAISE EXCEPTION '%: successor recorded_at must equal the closed recorded_until (seamless handoff, no gap or overlap)', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  -- Same-transaction aggregate event naming this exact closure.
  SELECT c.change_txid, c.closed_versions INTO ev_txid, ev_array
    FROM public.employment_changes c
   WHERE c.id = NEW.closed_by_change_id AND c.org_id = NEW.org_id
     AND c.employment_id = NEW.employment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%: closed_by_change_id must name an evidence event for the same employment', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF ev_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION '%: closure evidence must be written in the same transaction (change_txid must equal txid_current())', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF NOT (ev_array @> jsonb_build_array(jsonb_build_object(
      'table', TG_TABLE_NAME::text, 'identity', idcol_val::text,
      'version_no', NEW.version_no, 'row_id', NEW.id::text))) THEN
    RAISE EXCEPTION '%: evidence event must name this exact closure (table, identity, version_no, row_id) in closed_versions', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.hrm_closure_evidence_guard() IS
  'openbooks:hrm_closure_evidence_guard:v1 - deferred proof per closure: adjacent strictly-newer successor plus same-transaction aggregate event (txid-stamped) naming the exact row';

DROP TRIGGER IF EXISTS worker_employment_versions_closure_evidence ON public.worker_employment_versions;
CREATE CONSTRAINT TRIGGER worker_employment_versions_closure_evidence
  AFTER INSERT OR UPDATE ON public.worker_employment_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.hrm_closure_evidence_guard('employment_id');

DROP TRIGGER IF EXISTS employment_assignment_versions_closure_evidence ON public.employment_assignment_versions;
CREATE CONSTRAINT TRIGGER employment_assignment_versions_closure_evidence
  AFTER INSERT OR UPDATE ON public.employment_assignment_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.hrm_closure_evidence_guard('assignment_id');

DROP TRIGGER IF EXISTS reporting_relationships_closure_evidence ON public.reporting_relationships;
CREATE CONSTRAINT TRIGGER reporting_relationships_closure_evidence
  AFTER INSERT OR UPDATE ON public.reporting_relationships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.hrm_closure_evidence_guard('relationship_id');

-- Denormalized employment_id on assignment versions must match the
-- assignment's own employment (same-employment proof FKs cannot express).
CREATE OR REPLACE FUNCTION public.employment_assignment_versions_employment_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE actual_employment uuid;
BEGIN
  SELECT employment_id INTO actual_employment FROM public.employment_assignments
    WHERE id = NEW.assignment_id AND org_id = NEW.org_id;
  IF actual_employment IS NULL THEN
    RAISE EXCEPTION 'employment_assignment_versions: assignment must exist in the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF actual_employment IS DISTINCT FROM NEW.employment_id THEN
    RAISE EXCEPTION 'employment_assignment_versions: employment_id must match the assignment''s employment'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.employment_assignment_versions_employment_guard() IS
  'openbooks:employment_assignment_versions_employment_guard:v1 - denormalized employment_id proven against the assignment row';

DROP TRIGGER IF EXISTS employment_assignment_versions_employment ON public.employment_assignment_versions;
CREATE TRIGGER employment_assignment_versions_employment
  BEFORE INSERT OR UPDATE ON public.employment_assignment_versions
  FOR EACH ROW EXECUTE FUNCTION public.employment_assignment_versions_employment_guard();

-- Immutable transaction stamp: ALWAYS set here (the service never
-- supplies change_txid); the row is immutable afterwards, so the stamp can
-- never later claim a new transaction. Deferred closure proof compares it
-- with txid_current().
CREATE OR REPLACE FUNCTION public.employment_changes_stamp_txid()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  NEW.change_txid := txid_current();
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.employment_changes_stamp_txid() IS
  'openbooks:employment_changes_stamp_txid:v1 - every evidence event carries its writing top-level transaction id, immutable forever';

DROP TRIGGER IF EXISTS employment_changes_stamp ON public.employment_changes;
CREATE TRIGGER employment_changes_stamp
  BEFORE INSERT ON public.employment_changes
  FOR EACH ROW EXECUTE FUNCTION public.employment_changes_stamp_txid();

-- Evidence provenance: the assignment (when given) belongs to this
-- employment, and supersedes (when given) names earlier evidence for the
-- same (org, employment). Exact closure-to-row binding and the
-- same-transaction proof land deferred in hrm_closure_evidence_guard
-- because close/insert/evidence commit in one transaction in any order.
-- FKs alone cannot express any of this.
CREATE OR REPLACE FUNCTION public.employment_changes_provenance_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE actual_employment uuid;
BEGIN
  IF NEW.assignment_id IS NOT NULL THEN
    SELECT employment_id INTO actual_employment FROM public.employment_assignments
      WHERE id = NEW.assignment_id AND org_id = NEW.org_id;
    IF actual_employment IS NULL THEN
      RAISE EXCEPTION 'employment_changes: assignment must exist in the same organization'
        USING ERRCODE = '23514';
    END IF;
    IF actual_employment IS DISTINCT FROM NEW.employment_id THEN
      RAISE EXCEPTION 'employment_changes: assignment must belong to the same employment'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.employment_changes c
                   WHERE c.id = NEW.supersedes_id AND c.org_id = NEW.org_id
                     AND c.employment_id = NEW.employment_id) THEN
      RAISE EXCEPTION 'employment_changes: supersedes_id must name evidence for the same employment'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.employment_changes_provenance_guard() IS
  'openbooks:employment_changes_provenance_guard:v1 - assignment and supersedes proven to the same employment';

DROP TRIGGER IF EXISTS employment_changes_provenance ON public.employment_changes;
CREATE TRIGGER employment_changes_provenance
  BEFORE INSERT OR UPDATE ON public.employment_changes
  FOR EACH ROW EXECUTE FUNCTION public.employment_changes_provenance_guard();

-- Immutable evidence: updates and deletes are rejected outright (0086/0083
-- and pay_run_bank_file_immutable precedent). Legitimate closure happens on
-- the VERSION tables, never here, so this trigger blocks nothing legal.
CREATE OR REPLACE FUNCTION public.employment_changes_immutable_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'employment_changes: evidence rows are immutable; record a new revision instead'
    USING ERRCODE = '23514';
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.employment_changes_immutable_guard() IS
  'openbooks:employment_changes_immutable_guard:v1 - evidence immutable; closure lives on version tables';

DROP TRIGGER IF EXISTS employment_changes_immutable ON public.employment_changes;
CREATE TRIGGER employment_changes_immutable
  BEFORE UPDATE OR DELETE ON public.employment_changes
  FOR EACH ROW EXECUTE FUNCTION public.employment_changes_immutable_guard();

-- Manager-cycle backstop for the canonical service: walks ALL live line
-- paths along overlapping effective intersections (a manager with different
-- managers in successive slices contributes every slice whose window
-- intersects the path so far; a cycle reachable only through a later slice
-- is still found). Matrix edges and non-overlapping periods never
-- participate. Serialized per org with a REAL graph-revision write
-- (hrm_graph_revisions): the bump lands before the first table read, so
-- concurrent writers queue on the row lock, and a REPEATABLE READ (or
-- higher) transaction whose snapshot predates a concurrent commit fails
-- with 40001 instead of walking stale data. Depth beyond 64 is REFUSED,
-- never silently allowed.
CREATE OR REPLACE FUNCTION public.hrm_reporting_no_cycle()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  found_cycle boolean;
  max_depth integer;
BEGIN
  IF NEW.kind <> 'line' OR NEW.superseded_by IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Proven serialization FIRST (see hrm_graph_revisions): bump before any
  -- table read, so the walk below never runs on a stale snapshot.
  INSERT INTO public.hrm_graph_revisions AS g (org_id, rev)
    VALUES (NEW.org_id, 0)
    ON CONFLICT (org_id) DO NOTHING;
  UPDATE public.hrm_graph_revisions SET rev = rev + 1, updated_at = now()
    WHERE org_id = NEW.org_id;
  WITH RECURSIVE walk(emp, wfrom, wto, depth, path) AS (
    SELECT NEW.manager_employment_id, NEW.effective_from, NEW.effective_to, 1,
           ARRAY[NEW.employment_id, NEW.manager_employment_id]
    UNION
    SELECT r.manager_employment_id,
           GREATEST(r.effective_from, w.wfrom),
           CASE WHEN r.effective_to IS NULL THEN w.wto
                WHEN w.wto IS NULL THEN r.effective_to
                WHEN r.effective_to < w.wto THEN r.effective_to
                ELSE w.wto END,
           w.depth + 1,
           w.path || r.manager_employment_id
      FROM public.reporting_relationships r
      JOIN walk w ON r.org_id = NEW.org_id
       AND r.employment_id = w.emp
       AND r.kind = 'line'
       AND r.superseded_by IS NULL
       AND r.id IS DISTINCT FROM NEW.id
       AND daterange(r.effective_from, COALESCE(r.effective_to, 'infinity'::date), '[)')
         && daterange(w.wfrom, COALESCE(w.wto, 'infinity'::date), '[)')
       AND w.depth < 65
       AND NOT (r.manager_employment_id = ANY (w.path)
                AND r.manager_employment_id <> NEW.employment_id)
  )
  SELECT COALESCE((SELECT true FROM walk WHERE emp = NEW.employment_id LIMIT 1), false),
         COALESCE((SELECT MAX(depth) FROM walk), 0)
    INTO found_cycle, max_depth;
  IF found_cycle THEN
    RAISE EXCEPTION 'reporting_relationships: line reporting creates a management cycle'
      USING ERRCODE = '23514';
  END IF;
  IF max_depth >= 65 THEN
    RAISE EXCEPTION 'reporting_relationships: chain reaches 65 edges; refused, not validated'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.hrm_reporting_no_cycle() IS
  'openbooks:hrm_reporting_no_cycle:v1 - storage backstop for the canonical manager-cycle service; all live line paths with window intersection, per-org graph-revision write before first read, 65-edge refusal';

DROP TRIGGER IF EXISTS reporting_relationships_no_cycle ON public.reporting_relationships;
CREATE TRIGGER reporting_relationships_no_cycle
  BEFORE INSERT OR UPDATE ON public.reporting_relationships
  FOR EACH ROW EXECUTE FUNCTION public.hrm_reporting_no_cycle();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0177/0181 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all six tables. HRM stays out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'worker_employments', 'worker_employment_versions',
    'employment_assignments', 'employment_assignment_versions',
    'employment_changes', 'reporting_relationships',
    'hrm_graph_revisions'] LOOP
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

COMMENT ON TABLE public.worker_employments IS
  'HRM stable employment identity (0184): one worker party employed by one legal-employer subsidiary. No status, dates, or flags: lifecycle lives in worker_employment_versions. Employer immutable (worker_employments_identity_guard); worker remap only via audited party merge. Canonical employer, no legacy projection: no backfill here; ambiguous source employer/start refused by the one-time migration, never fabricated.';
COMMENT ON COLUMN public.worker_employments.employer_subsidiary_id IS
  'Legal employer of this employment: the single employer of record. Transfer = terminate + rehire, never an edit (worker_employments_identity_guard).';
COMMENT ON TABLE public.worker_employment_versions IS
  'HRM employment status versions (0184): half-open effective [effective_from, effective_to) and recorded [recorded_at, recorded_until) intervals. Live versions never overlap per employment (worker_employment_versions_no_overlap + recorded_no_ambiguity); closed rows immutable (closure guard).';
COMMENT ON TABLE public.employment_assignments IS
  'HRM stable assignment slots (0184): one row per primary/additional slot within an employment. Concurrent same-start assignments are separate rows by design.';
COMMENT ON TABLE public.employment_assignment_versions IS
  'HRM assignment versions (0184): title, placement, decimal FTE, and the effective-dated is_primary fact. At most one live primary per employment at any effective time (employment_assignment_versions_single_primary).';
COMMENT ON TABLE public.employment_changes IS
  'HRM immutable revision evidence (0184): every version closure appends one row with prior image, non-blank reason, and a users row or named system source. Updates and deletes rejected (employment_changes_immutable_guard).';
COMMENT ON TABLE public.reporting_relationships IS
  'HRM dated reporting lines (0184): line = singular (storage-enforced single live line per subordinate), matrix = simultaneous. Cycles rejected (hrm_reporting_no_cycle).';
