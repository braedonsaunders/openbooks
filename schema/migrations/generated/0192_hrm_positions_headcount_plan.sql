-- OpenBooks forward migration 0192_hrm_positions_headcount_plan.
--
-- Positions and the headcount plan (HR-3). Separates the funded establishment
-- (positions) from the people who hold them (0184 employments/assignments):
--
--   positions / position_versions are stable identity + bitemporal versions
--   in the exact 0184 shape (version_no, effective [effective_from,
--   effective_to), recorded [recorded_at, recorded_until), superseded_by,
--   closed_by_change_id, closure guards, GiST no-overlap exclusion, RLS).
--   Status lifecycle is planned, open, filled, frozen, closed. Transition
--   rules (which status may follow which, close refused while a live primary
--   assignment names the position) live in the canonical service
--   (engine/src/hrm/positions.ts), never here: storage pins the value set
--   only, the same division 0184 establishes.
--   position_funding is one plan row per (position, fiscal period): funded
--   FTE plus an optional cost-plan amount. Fiscal periods are referenced the
--   way budgets reference them (budget_lines.period_id): a plain FK to
--   accounting_periods(id) with a same-org proof in the service
--   (assertPositionRefs), not a composite tenant FK. Storage pins
--   funded_fte >= 0 only. Whether funded FTE sits between 0 and planned FTE
--   is deliberately NOT a constraint: plans legitimately over- or under-fund,
--   so the service reports that comparison as a named preflight refusal
--   instead of storage rejecting the row.
--   position_changes is the immutable evidence ledger for position writes,
--   in the employment_changes style (revision per position, reason, actor,
--   txid stamp, closed_versions with deferred forward AND reverse proof).
--   Employment-side assignment onto a position stays evidenced by
--   employment_changes ('assignment_superseded'); the position side records
--   a non-closure 'assigned'/'unassigned' event so the position history is
--   complete without a second closure proof over employment rows.
--   employment_assignment_versions gains position_id (nullable, tenant FK to
--   positions within the org). An assignment on a position inherits nothing:
--   title, department and location stay on the assignment version, and a
--   preflight reports disagreement as a warning, never a rewrite.
--
-- Scope of THIS file: the three new tables, the position_id column, storage
-- invariants, and RLS. It alters no payroll table and performs no backfill.
-- Positions stay out of the generic governed-query catalog (no
-- openbooks_refresh_query_catalog call), exactly like the 0184 HRM tables:
-- the workforce report entities read them through their own governed SQL.
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

CREATE TABLE IF NOT EXISTS public.positions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    -- Stable establishment code, unique per org (e.g. 'ENG-1042'). The human
    -- handle the vacancy read and the drawer name; renames are a new code
    -- only through the service, never a silent edit that orphans history.
    position_code text NOT NULL,
    -- Aggregate concurrency revision, bumped by exactly one on ANY change
    -- under this position (version revise, funding write, close). Writers
    -- match this revision and increment it in one UPDATE; a zero-row write
    -- is a refusal, never a success.
    revision integer NOT NULL DEFAULT 1,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT positions_revision CHECK (revision >= 1),
    CONSTRAINT positions_code_not_blank
      CHECK (char_length(btrim(position_code)) > 0)
);

CREATE TABLE IF NOT EXISTS public.position_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    position_id uuid NOT NULL,
    version_no integer NOT NULL,
    -- Establishment title as of this version. Assignments naming the
    -- position keep their own title (no silent inheritance); disagreement
    -- is a service preflight warning.
    title text NOT NULL,
    department_id uuid,
    location_id uuid,
    -- Legal employer owning this headcount slot. Non-null: headcount and
    -- subsidiary scoping must never misattribute a position.
    employer_subsidiary_id uuid NOT NULL,
    -- Job family or grade, free text for now (no grade table in this slice).
    job_grade text,
    -- Funded establishment size for this version, e.g. 1.0000. Capacity
    -- totals are service-side; storage pins shape only (see the NaN note
    -- on employment_assignment_versions_fte in 0184, mirrored here).
    planned_fte numeric(7, 4) NOT NULL,
    -- Lifecycle: planned (approved but not recruiting), open (recruiting),
    -- filled (holder in place), frozen (temporarily held), closed (retired).
    status text NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_until timestamp with time zone,
    -- Version closing this one (null = live). Always names a real
    -- version_no of the same position (closure guards verify).
    superseded_by integer,
    -- Link to the ONE aggregate position_changes event evidencing this
    -- closure (null = live). Composite FK to position_changes(org_id, id).
    closed_by_change_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT position_versions_title_not_blank
      CHECK (char_length(btrim(title)) > 0),
    CONSTRAINT position_versions_status
      CHECK (status IN ('planned', 'open', 'filled', 'frozen', 'closed')),
    CONSTRAINT position_versions_range
      CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT position_versions_recorded
      CHECK (recorded_until IS NULL OR recorded_until > recorded_at),
    CONSTRAINT position_versions_no CHECK (version_no >= 1),
    CONSTRAINT position_versions_closure
      CHECK ((superseded_by IS NULL) = (recorded_until IS NULL)
      AND (superseded_by IS NULL) = (closed_by_change_id IS NULL)),
    CONSTRAINT position_versions_finite_time CHECK (
      effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND (effective_to IS NULL
           OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
      AND recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
      AND (recorded_until IS NULL
           OR (recorded_until >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
               AND recorded_until < TIMESTAMPTZ '10000-01-01 00:00:00+00'))),
    -- NaN sorts ABOVE ordinary numbers in PostgreSQL numeric, so planned_fte
    -- > 0 alone accepts NaN; the explicit != 'NaN' rejects it.
    CONSTRAINT position_versions_planned_fte CHECK (planned_fte > 0 AND planned_fte != 'NaN')
);

CREATE TABLE IF NOT EXISTS public.position_funding (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    position_id uuid NOT NULL,
    -- Fiscal period this plan row funds, referenced the way budgets
    -- reference periods (budget_lines_period_id_fkey): a plain FK to
    -- accounting_periods(id). Same-org membership is proven by the service
    -- (assertPositionRefs), which names the period when it refuses.
    period_id uuid NOT NULL,
    -- Funded FTE for the period, e.g. 1.0000. Deliberately NOT bounded
    -- above by planned_fte: plans legitimately over- or under-fund, so the
    -- plan-vs-funded comparison is a named service preflight, never a row
    -- rejection. Storage pins non-negative shape only.
    funded_fte numeric(7, 4) NOT NULL,
    -- Opaque dimension reference for the funding source (cost center, grant,
    -- program). No FK: the source dimension is the planning consumer's
    -- domain, not a table this migration may invent. Null = unfunded.
    funding_source_id uuid,
    -- Optional cost plan for the period. Amount and currency are paired:
    -- one without the other is a half-written plan and is refused.
    amount numeric(19, 4),
    currency text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT position_funding_funded_fte CHECK (funded_fte >= 0 AND funded_fte != 'NaN'),
    -- Three-valued-logic note: the IS NULL arms are explicit because a NULL
    -- operand would make the comparison NULL (not false) and CHECK would
    -- wrongly pass a half-written plan.
    CONSTRAINT position_funding_amount_currency CHECK (
      (amount IS NULL AND currency IS NULL)
      OR (amount IS NOT NULL AND currency IS NOT NULL
          AND amount != 'NaN' AND currency ~ '^[A-Z]{3}$')
    )
);

CREATE TABLE IF NOT EXISTS public.position_changes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    position_id uuid NOT NULL,
    revision integer NOT NULL,
    change_kind text NOT NULL,
    prior_snapshot jsonb NOT NULL,
    reason text NOT NULL,
    recorded_source text NOT NULL DEFAULT 'user',
    -- User actor (position_changes_recorded_by_fkey, never nulled by user
    -- deletion so evidence stays attributable); null for system actors,
    -- which instead name recorded_source_ref.
    recorded_by uuid,
    -- The autonomous process or job, e.g. 'position-funding <run id>'.
    recorded_source_ref text,
    -- Immutable transaction stamp, ALWAYS set by
    -- position_changes_stamp_txid (the service never supplies it).
    change_txid bigint NOT NULL,
    -- Exact closed-version/before-image array for closures closed under
    -- this ONE aggregate change. Empty array for non-closure events. Proven
    -- deferred in position_closure_evidence_guard against the linked
    -- version rows, and reversed in position_evidence_closure_reverse_guard.
    closed_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT position_changes_kind CHECK (change_kind IN
      ('created', 'revised', 'funded', 'assigned', 'unassigned', 'closed')),
    CONSTRAINT position_changes_revision CHECK (revision >= 1),
    CONSTRAINT position_changes_reason
      CHECK (char_length(btrim(reason)) > 0),
    CONSTRAINT position_changes_snapshot
      CHECK (jsonb_typeof(prior_snapshot) = 'object'),
    -- Three-valued-logic note: recorded_source_ref IS NOT NULL is explicit
    -- because btrim(NULL) yields NULL (not false) and CHECK would wrongly
    -- pass a system actor with no named source.
    CONSTRAINT position_changes_actor CHECK (
      (recorded_source = 'user' AND recorded_by IS NOT NULL
       AND recorded_source_ref IS NULL)
      OR (recorded_source = 'system' AND recorded_by IS NULL
          AND recorded_source_ref IS NOT NULL
          AND char_length(btrim(recorded_source_ref)) > 0)),
    CONSTRAINT position_changes_closed_versions
      CHECK (jsonb_typeof(closed_versions) = 'array'),
    CONSTRAINT position_changes_finite_time CHECK (
      recorded_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
      AND recorded_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
    )
);

-- The employment assignment's position link. Nullable: most assignments
-- predate positions, and an assignment without a position is legitimate.
ALTER TABLE ONLY public.employment_assignment_versions
  ADD COLUMN IF NOT EXISTS position_id uuid;

COMMENT ON COLUMN public.employment_assignment_versions.position_id IS
  'HRM position link (0192): the funded establishment slot this assignment holds. Title, department and location stay on the assignment version and are never inherited; disagreement with the position version is a service preflight warning.';

-- ---------------------------------------------------------------------------
-- Primary keys, unique keys, indexes. All added defensively (re-runnable).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_pkey') THEN
  ALTER TABLE ONLY public.positions ADD CONSTRAINT positions_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_pkey') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_funding_pkey') THEN
  ALTER TABLE ONLY public.position_funding ADD CONSTRAINT position_funding_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_changes_pkey') THEN
  ALTER TABLE ONLY public.position_changes ADD CONSTRAINT position_changes_pkey PRIMARY KEY (id); END IF; END $$;

-- Covering (org_id, id) uniques: the composite tenant FKs below need them.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_org_id_id_unique') THEN
  ALTER TABLE ONLY public.positions ADD CONSTRAINT positions_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_org_id_id_unique') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_funding_org_id_id_unique') THEN
  ALTER TABLE ONLY public.position_funding ADD CONSTRAINT position_funding_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_changes_org_id_id_unique') THEN
  ALTER TABLE ONLY public.position_changes ADD CONSTRAINT position_changes_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- One establishment code per organization.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_org_code_unique') THEN
  ALTER TABLE ONLY public.positions ADD CONSTRAINT positions_org_code_unique
    UNIQUE (org_id, position_code); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_position_no') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_position_no
    UNIQUE (org_id, position_id, version_no); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_changes_position_revision') THEN
  ALTER TABLE ONLY public.position_changes ADD CONSTRAINT position_changes_position_revision
    UNIQUE (org_id, position_id, revision); END IF; END $$;
-- One plan row per (position, fiscal period): a second row for the same
-- period is a correction to the first, recorded as a new funding write with
-- evidence, never a silent second plan.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_funding_position_period') THEN
  ALTER TABLE ONLY public.position_funding ADD CONSTRAINT position_funding_position_period
    UNIQUE (org_id, position_id, period_id); END IF; END $$;

CREATE INDEX IF NOT EXISTS positions_org ON public.positions USING btree (org_id);
CREATE INDEX IF NOT EXISTS position_versions_position ON public.position_versions USING btree (org_id, position_id, effective_from);
CREATE INDEX IF NOT EXISTS position_funding_position ON public.position_funding USING btree (org_id, position_id);
CREATE INDEX IF NOT EXISTS position_funding_period ON public.position_funding USING btree (org_id, period_id);
CREATE INDEX IF NOT EXISTS position_changes_position ON public.position_changes USING btree (org_id, position_id, revision);
CREATE INDEX IF NOT EXISTS employment_assignment_versions_position ON public.employment_assignment_versions USING btree (org_id, position_id);

-- ---------------------------------------------------------------------------
-- Tenant foreign keys (composite org coherence, 0044 pattern). No ON DELETE
-- CASCADE on position history: deletes are RESTRICTed (NO ACTION default);
-- history is retired via version closure, never deleted. Funding rows are
-- plan data the service rewrites with evidence; the position row itself pins
-- them while it lives.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_org_id_fkey') THEN
  ALTER TABLE ONLY public.positions ADD CONSTRAINT positions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_org_id_fkey') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_position_tenant_fkey') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_position_tenant_fkey
    FOREIGN KEY (org_id, position_id) REFERENCES public.positions(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_department_tenant_fkey') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_department_tenant_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_location_tenant_fkey') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_location_tenant_fkey
    FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_employer_tenant_fkey') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_employer_tenant_fkey
    FOREIGN KEY (org_id, employer_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_change_tenant_fkey') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_change_tenant_fkey
    FOREIGN KEY (org_id, closed_by_change_id) REFERENCES public.position_changes(org_id, id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_funding_org_id_fkey') THEN
  ALTER TABLE ONLY public.position_funding ADD CONSTRAINT position_funding_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_funding_position_tenant_fkey') THEN
  ALTER TABLE ONLY public.position_funding ADD CONSTRAINT position_funding_position_tenant_fkey
    FOREIGN KEY (org_id, position_id) REFERENCES public.positions(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_funding_period_fkey') THEN
  ALTER TABLE ONLY public.position_funding ADD CONSTRAINT position_funding_period_fkey
    FOREIGN KEY (period_id) REFERENCES public.accounting_periods(id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_changes_org_id_fkey') THEN
  ALTER TABLE ONLY public.position_changes ADD CONSTRAINT position_changes_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_changes_position_tenant_fkey') THEN
  ALTER TABLE ONLY public.position_changes ADD CONSTRAINT position_changes_position_tenant_fkey
    FOREIGN KEY (org_id, position_id) REFERENCES public.positions(org_id, id) DEFERRABLE; END IF; END $$;
-- The evidence actor must stay a real user row: NO ACTION (never nulled by
-- user deletion; deactivate users instead).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_changes_recorded_by_fkey') THEN
  ALTER TABLE ONLY public.position_changes ADD CONSTRAINT position_changes_recorded_by_fkey
    FOREIGN KEY (recorded_by) REFERENCES public.users(id) DEFERRABLE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employment_assignment_versions_position_tenant_fkey') THEN
  ALTER TABLE ONLY public.employment_assignment_versions ADD CONSTRAINT employment_assignment_versions_position_tenant_fkey
    FOREIGN KEY (org_id, position_id) REFERENCES public.positions(org_id, id) DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- GiST exclusion (0051 pattern): live versions of one position never overlap
-- in effective AND recorded time at once. Half-open '[)': adjacent
-- [a,b)+[b,c) do NOT overlap. Close-then-insert-then-evidence in one
-- transaction (the 0184 write order) never triple-overlaps.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_no_overlap') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_no_overlap
    EXCLUDE USING gist (
      position_id WITH =,
      daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)') WITH &&,
      tstzrange(recorded_at, COALESCE(recorded_until, 'infinity'::timestamptz), '[)') WITH &&
    ) DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Storage triggers.
-- ---------------------------------------------------------------------------

-- Controlled version closure (0184 shape): closed rows are immutable; the
-- ONLY allowed UPDATEs on a live row are the closing transition
-- (recorded_until + superseded_by + closed_by_change_id, touching nothing
-- else) and a pure audit touch (updated_at/updated_by only). Deletes are
-- rejected: retire via closure, never DELETE.
CREATE OR REPLACE FUNCTION public.position_versions_closure_guard()
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
    RAISE EXCEPTION 'position_versions: rows are never deleted; close with a superseding version'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'position_versions: closed versions are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by IS NULL AND NEW.recorded_until IS NULL
     AND NEW.closed_by_change_id IS NULL
     AND to_jsonb(NEW) - ARRAY['updated_at','updated_by']
       = to_jsonb(OLD) - ARRAY['updated_at','updated_by'] THEN
    RETURN NEW;
  END IF;
  IF NEW.superseded_by IS NULL OR NEW.recorded_until IS NULL THEN
    RAISE EXCEPTION 'position_versions: live rows are append-only; the only allowed UPDATE is the closing transition (recorded_until + superseded_by) or a pure audit touch'
      USING ERRCODE = '23514';
  END IF;
  -- Explicit allowlist: ONLY recorded_until, superseded_by,
  -- closed_by_change_id, and the audit touch (updated_at/updated_by) may
  -- differ. The successor reference and its evidence are validated deferred
  -- at commit (position_closure_evidence_guard).
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.position_id IS DISTINCT FROM OLD.position_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.employer_subsidiary_id IS DISTINCT FROM OLD.employer_subsidiary_id
     OR NEW.job_grade IS DISTINCT FROM OLD.job_grade
     OR NEW.planned_fte IS DISTINCT FROM OLD.planned_fte
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'position_versions: closure sets recorded_until + superseded_by + closed_by_change_id (plus audit touch) only'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.position_versions_closure_guard() IS
  'openbooks:position_versions_closure_guard:v1 - closed rows immutable; live rows accept only the closing transition or a pure audit touch; successor + evidence proven deferred by position_closure_evidence_guard';

DROP TRIGGER IF EXISTS position_versions_closure ON public.position_versions;
CREATE TRIGGER position_versions_closure
  BEFORE UPDATE OR DELETE ON public.position_versions
  FOR EACH ROW EXECUTE FUNCTION public.position_versions_closure_guard();

-- Deferred closure proof for position versions, mirroring
-- hrm_closure_evidence_guard (0184) over the position evidence ledger:
-- every version closed in a transaction must link (closed_by_change_id) a
-- position_changes event of the SAME position that (a) was written in THIS
-- transaction (change_txid = txid_current(), stamped immutable at insert),
-- and (b) names this exact closure in its closed_versions array WITH the
-- exact before-image. The successor must be strictly newer and start
-- exactly where the closed row ends (seamless handoff).
CREATE OR REPLACE FUNCTION public.position_closure_evidence_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ev_txid bigint;
  ev_array jsonb;
  succ_at timestamptz;
  succ_n integer;
  elem jsonb;
  elem_n integer;
  expected_before jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.superseded_by IS NULL THEN
      RETURN NULL;
    END IF;
  ELSIF OLD.superseded_by IS NOT NULL OR NEW.superseded_by IS NULL THEN
    RETURN NULL;
  END IF;
  IF NEW.closed_by_change_id IS NULL THEN
    RAISE EXCEPTION 'position_versions: closing a version requires closed_by_change_id (the aggregate evidence event)'
      USING ERRCODE = '23514';
  END IF;
  -- Real adjacent successor: exists, strictly newer, starts exactly here.
  -- PL/pgSQL EXECUTE never sets FOUND, so the presence check reads
  -- ROW_COUNT (the 0184 guard's documented rule, repeated here because the
  -- wrong check compiles and silently proves nothing).
  EXECUTE
    'SELECT recorded_at FROM public.position_versions WHERE org_id = $1 AND position_id = $2 AND version_no = $3'
    INTO succ_at
    USING NEW.org_id, NEW.position_id, NEW.superseded_by;
  GET DIAGNOSTICS succ_n = ROW_COUNT;
  IF succ_n = 0 THEN
    RAISE EXCEPTION 'position_versions: superseded_by must name a real version_no of the same position (no dangling pointers)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.superseded_by <= NEW.version_no THEN
    RAISE EXCEPTION 'position_versions: successor version_no must be strictly newer (rejects self and backwards)'
      USING ERRCODE = '23514';
  END IF;
  IF succ_at IS DISTINCT FROM NEW.recorded_until THEN
    RAISE EXCEPTION 'position_versions: successor recorded_at must equal the closed recorded_until (seamless handoff, no gap or overlap)'
      USING ERRCODE = '23514';
  END IF;
  -- Same-transaction aggregate event naming this exact closure. Plain
  -- SELECT ... INTO sets FOUND (unlike EXECUTE above), so IF NOT FOUND is
  -- correct here.
  SELECT c.change_txid, c.closed_versions INTO ev_txid, ev_array
    FROM public.position_changes c
   WHERE c.id = NEW.closed_by_change_id AND c.org_id = NEW.org_id
     AND c.position_id = NEW.position_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'position_versions: closed_by_change_id must name an evidence event for the same position'
      USING ERRCODE = '23514';
  END IF;
  IF ev_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'position_versions: closure evidence must be written in the same transaction (change_txid must equal txid_current())'
      USING ERRCODE = '23514';
  END IF;
  -- Exactly one element must name this closure: zero means the event does
  -- not evidence this close; two or more means the array double-counts one
  -- row and no single before-image can be authoritative.
  SELECT count(*) INTO elem_n FROM jsonb_array_elements(ev_array) AS e
   WHERE e @> jsonb_build_object(
      'table', 'position_versions', 'identity', NEW.position_id::text,
      'version_no', NEW.version_no, 'row_id', NEW.id::text);
  IF elem_n = 0 THEN
    RAISE EXCEPTION 'position_versions: evidence event must name this exact closure (table, identity, version_no, row_id) in closed_versions'
      USING ERRCODE = '23514';
  ELSIF elem_n > 1 THEN
    RAISE EXCEPTION 'position_versions: evidence event names this closure more than once (duplicate closed_versions entries)'
      USING ERRCODE = '23514';
  END IF;
  SELECT e INTO elem FROM jsonb_array_elements(ev_array) AS e
   WHERE e @> jsonb_build_object(
      'table', 'position_versions', 'identity', NEW.position_id::text,
      'version_no', NEW.version_no, 'row_id', NEW.id::text)
   LIMIT 1;
  -- Exact prior image, full row, no column subtracted: on UPDATE the element
  -- must carry OLD as it stood before this close; on INSERT of an
  -- already-closed row it must carry NEW as written.
  IF TG_OP = 'INSERT' THEN
    expected_before := to_jsonb(NEW);
  ELSE
    expected_before := to_jsonb(OLD);
  END IF;
  IF NOT (elem ? 'before') OR (elem->'before' IS DISTINCT FROM expected_before) THEN
    RAISE EXCEPTION 'position_versions: evidence event must carry the exact before-image of this closure in closed_versions[].before'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.position_closure_evidence_guard() IS
  'openbooks:position_closure_evidence_guard:v1 - deferred proof per closure: adjacent strictly-newer successor (ROW_COUNT presence) plus same-transaction aggregate position_changes event (txid-stamped) naming the exact row with its exact before-image';

DROP TRIGGER IF EXISTS position_versions_closure_evidence ON public.position_versions;
CREATE CONSTRAINT TRIGGER position_versions_closure_evidence
  AFTER INSERT OR UPDATE ON public.position_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.position_closure_evidence_guard();

-- Deferred REVERSE proof (0184 shape): every closed_versions element must
-- name exactly one really-closed position_versions row of this position
-- linked back to THIS event. Without it an event could claim nonexistent
-- closures and no check would fire.
CREATE OR REPLACE FUNCTION public.position_evidence_closure_reverse_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  elem jsonb;
  tbl text;
  row_n integer;
BEGIN
  -- Governed amend path (fixture teardown, historical replay): the existing
  -- house mechanism, never a production bypass.
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;
  FOR elem IN SELECT * FROM jsonb_array_elements(NEW.closed_versions) LOOP
    tbl := elem->>'table';
    IF tbl IS DISTINCT FROM 'position_versions' THEN
      RAISE EXCEPTION 'position_changes: closed_versions element names an unknown closure table %', tbl
        USING ERRCODE = '23514';
    END IF;
    IF jsonb_typeof(elem->'before') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'position_changes: closed_versions element for % must carry a before-image object', tbl
        USING ERRCODE = '23514';
    END IF;
    -- count(*) always returns exactly one row, so INTO needs no FOUND dance.
    SELECT count(*) INTO row_n FROM public.position_versions
     WHERE id = (elem->>'row_id')::uuid AND org_id = NEW.org_id
       AND position_id = (elem->>'identity')::uuid
       AND version_no = (elem->>'version_no')::int
       AND position_id = NEW.position_id
       AND superseded_by IS NOT NULL AND closed_by_change_id = NEW.id;
    IF row_n <> 1 THEN
      RAISE EXCEPTION 'position_changes: closed_versions element must name a real closed row of this position linked back to this event (identity %)', elem->>'identity'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.position_evidence_closure_reverse_guard() IS
  'openbooks:position_evidence_closure_reverse_guard:v1 - deferred reverse proof per event: every closed_versions element names exactly one really-closed row of this position linked back to this event';

DROP TRIGGER IF EXISTS position_changes_closure_reverse ON public.position_changes;
CREATE CONSTRAINT TRIGGER position_changes_closure_reverse
  AFTER INSERT ON public.position_changes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.position_evidence_closure_reverse_guard();

-- Immutable transaction stamp: ALWAYS set here (the service never supplies
-- change_txid); the row is immutable afterwards, so the stamp can never
-- later claim a new transaction. Per-table function (not shared with
-- employment_changes_stamp_txid): the COMMENT is the audit trail's
-- provenance, and a shared name would misattribute position evidence.
CREATE OR REPLACE FUNCTION public.position_changes_stamp_txid()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  NEW.change_txid := txid_current();
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.position_changes_stamp_txid() IS
  'openbooks:position_changes_stamp_txid:v1 - every position evidence event carries its writing top-level transaction id, immutable forever';

DROP TRIGGER IF EXISTS position_changes_stamp ON public.position_changes;
CREATE TRIGGER position_changes_stamp
  BEFORE INSERT ON public.position_changes
  FOR EACH ROW EXECUTE FUNCTION public.position_changes_stamp_txid();

-- Evidence provenance: the position belongs to this org. Assignment
-- cross-references (which employment holds the position) ride in
-- prior_snapshot JSON, never as FKs: the employment side owns that proof
-- (employment_changes), and a second FK graph would couple the ledgers.
CREATE OR REPLACE FUNCTION public.position_changes_provenance_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.positions p
                  WHERE p.id = NEW.position_id AND p.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'position_changes: position must exist in the same organization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.position_changes_provenance_guard() IS
  'openbooks:position_changes_provenance_guard:v1 - evidence bound to a real position of the same organization';

DROP TRIGGER IF EXISTS position_changes_provenance ON public.position_changes;
CREATE TRIGGER position_changes_provenance
  BEFORE INSERT OR UPDATE ON public.position_changes
  FOR EACH ROW EXECUTE FUNCTION public.position_changes_provenance_guard();

-- Immutable evidence (0184 precedent): updates and deletes are rejected
-- outright. Legitimate closure happens on position_versions, never here.
CREATE OR REPLACE FUNCTION public.position_changes_immutable_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'position_changes: evidence rows are immutable; record a new revision instead'
    USING ERRCODE = '23514';
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.position_changes_immutable_guard() IS
  'openbooks:position_changes_immutable_guard:v1 - evidence immutable; closure lives on position_versions';

DROP TRIGGER IF EXISTS position_changes_immutable ON public.position_changes;
CREATE TRIGGER position_changes_immutable
  BEFORE UPDATE OR DELETE ON public.position_changes
  FOR EACH ROW EXECUTE FUNCTION public.position_changes_immutable_guard();

-- Position identity is stable: org can never change after versions exist
-- (composite children reference it), and the code is the human handle the
-- vacancy read names — a code change is a new position through the service,
-- never an edit that orphans history. (Composite FKs are ON UPDATE NO
-- ACTION, which only blocks the parent side; this pins the child side.)
CREATE OR REPLACE FUNCTION public.positions_identity_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.position_code IS DISTINCT FROM OLD.position_code THEN
    RAISE EXCEPTION 'positions: org_id and position_code are immutable (close the position and open a new one, never move it)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.positions_identity_guard() IS
  'openbooks:positions_identity_guard:v1 - stable establishment identity; parent keys immutable so version and funding provenance proofs cannot be invalidated';

DROP TRIGGER IF EXISTS positions_identity ON public.positions;
CREATE TRIGGER positions_identity
  BEFORE UPDATE ON public.positions
  FOR EACH ROW EXECUTE FUNCTION public.positions_identity_guard();

-- The 0184 employment_assignment_versions_closure_guard allowlists every
-- content column a closure must not touch. position_id (added above) is
-- content: without this replacement a forged closure could repoint an
-- assignment at another position while closing it, and the guard would not
-- compare the column. Same function name, same trigger: only the
-- position_id arm is added.
CREATE OR REPLACE FUNCTION public.employment_assignment_versions_closure_guard()
RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
BEGIN
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
  IF NEW.superseded_by IS NULL AND NEW.recorded_until IS NULL
     AND NEW.closed_by_change_id IS NULL
     AND to_jsonb(NEW) - ARRAY['updated_at','updated_by']
       = to_jsonb(OLD) - ARRAY['updated_at','updated_by'] THEN
    RETURN NEW;
  END IF;
  IF NEW.superseded_by IS NULL OR NEW.recorded_until IS NULL THEN
    RAISE EXCEPTION 'employment_assignment_versions: live rows are append-only; the only allowed UPDATE is the closing transition (recorded_until + superseded_by) or a pure audit touch'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.position_id IS DISTINCT FROM OLD.position_id
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
  'openbooks:employment_assignment_versions_closure_guard:v2 - closed rows immutable; live rows accept only the closing transition or a pure audit touch; successor + evidence proven deferred by hrm_closure_evidence_guard; v2 adds position_id (0192) to the content allowlist so a closure cannot repoint the position link';

-- ---------------------------------------------------------------------------
-- Tenant RLS (0177/0181/0184 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all four tables. Positions stay out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'positions', 'position_versions',
    'position_funding', 'position_changes'] LOOP
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

COMMENT ON TABLE public.positions IS
  'HRM stable position identity (0192): one funded establishment slot per org-scoped code. No title, dates, or status: lifecycle lives in position_versions. Code and org immutable (positions_identity_guard).';
COMMENT ON TABLE public.position_versions IS
  'HRM position versions (0192): title, placement, employer, grade, planned FTE and lifecycle status with half-open effective [effective_from, effective_to) and recorded [recorded_at, recorded_until) intervals. Live versions never overlap per position (position_versions_no_overlap); closed rows immutable (closure guard).';
COMMENT ON TABLE public.position_funding IS
  'HRM headcount-plan funding (0192): one plan row per position and fiscal period (accounting_periods, budget-style reference) with funded FTE and an optional cost-plan amount. funded_fte >= 0 only: the plan-vs-funded comparison is a service preflight, never a row rejection.';
COMMENT ON TABLE public.position_changes IS
  'HRM immutable position revision evidence (0192): every position write appends one row with prior image, non-blank reason, and a users row or named system source. Updates and deletes rejected (position_changes_immutable_guard).';
COMMENT ON COLUMN public.position_funding.funding_source_id IS
  'Opaque planning-dimension reference (cost center, grant, program): carried for planning joins, never resolved by HRM. Null = unfunded by a named source.';
