-- OpenBooks forward migration 0221_hrm_compensation_architecture.
--
-- Compensation job architecture, pay bands, and merit cycles (HR-12).
--
-- What a role SHOULD pay, whether a person sits in range, and how a raise
-- is decided — the layer between positions (planned/funded FTE, 0192) and
-- payroll (what is paid). Nothing here stores what anyone IS paid: cycle
-- lines SNAPSHOT the payroll-side effective wage at open through the
-- labor-costing wage rate service, and the push writes the decided rate
-- back as a versioned labor_cost_rates row. Bands are the SHOULD.
--
--   hrm_job_families — stable identity per org code (e.g. 'ENG'): the
--   craft a ladder belongs to. Deactivation preserves history; a family
--   with levels cannot be deleted (RESTRICT), only retired.
--   hrm_job_levels — one rung per (org, family-or-org-wide, code). A NULL
--   family_id is the org-wide ladder (one ladder for small orgs); a set
--   family_id is that family's ladder. rank orders rungs within the
--   ladder; equal_value_criteria is the org-declared gender-neutral
--   criteria the EU pay-transparency directive requires (skills, effort,
--   responsibility, working_conditions with weights) — storage pins the
--   key set, the service requires at least one criterion per level.
--   hrm_pay_bands — versioned SHOULD-pay rows: at most one live row per
--   scope + effective_from (partial unique on effective_to IS NULL is a
--   trigger-blind race under READ COMMITTED, so the service closes the
--   prior row and opens the new one in one transaction and storage pins
--   the overlap exclusion instead). Scope narrows family → level →
--   employer subsidiary → location; a NULL scope column is a wider band.
--   min <= target <= max is a storage CHECK. A band change is a new row,
--   never an overwrite: superseded rows are immutable except a pure
--   audit touch (the same terminal-immutability guard 0195 uses).
--   position_versions gains job_level_id (nullable, additive): employment
--   versions read their band through the position at the as-of date and
--   never copy band ids onto employments.
--   hrm_comp_cycles — one merit/promotion/adjustment/cola round: status
--   lifecycle draft → open → in_review → approved → pushed → closed
--   (cancelled from any non-terminal state); effective_on is the date the
--   new rates take effect. guideline is either a matrix (rows = the org's
--   review-scale performance buckets, columns = compa-ratio quartiles,
--   cells = {min,max} percent) or a declared formula over rating,
--   compa_ratio and tenure_years — evaluated by ONE fixed-grammar
--   evaluator in the service (never eval); storage pins the shape only.
--   scope is the 0193 applies_to shape (employer subsidiary/department),
--   stored as jsonb with the same read-only generated-column projection
--   0193 uses so governed surfaces never read raw JSON.
--   hrm_comp_cycle_budgets — one row per (cycle, department-or-manager):
--   exactly one of department_id / manager_party_id is set (storage
--   CHECK). amount is the envelope; allocated_amount is COMPUTED AT READ
--   TIME from approved/proposed lines, never stored (a stored copy could
--   disagree with the lines it summarises).
--   hrm_comp_cycle_lines — one row per (cycle, employment): current_rate
--   + currency + basis SNAPSHOTTED at open from the payroll-side
--   effective wage, compa_ratio and the resolved guideline range stored
--   beside them so a later band change cannot reinterpret a decided
--   line; status pending → proposed → approved/rejected → pushed.
--   UNIQUE (cycle_id, employment_id): one line per person per cycle.
--   hrm_comp_events — the append-only evidence ledger (opened, proposed,
--   reopened, approved, rejected, budget_changed, pushed, closed,
--   cancelled): updates refused on every path, deletes only on the
--   governed amend path (the 0195 application-events rule).
--   hrm_comp_statements — frozen per-employment payloads (current rate,
--   band placement, employer-paid benefits, the cycle decision) with an
--   optional rendered PDF file link; regeneration is a new row, never an
--   overwrite of a delivered statement.
--
-- Scope of THIS file: the eight new tables, the position_versions column,
-- storage invariants, and RLS. It alters no payroll table, performs no
-- backfill, and registers no catalog refresh (HRM stays out of the
-- generic governed-query catalog like 0184/0192/0195).
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

CREATE TABLE IF NOT EXISTS public.hrm_job_families (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    -- Stable craft code, unique per org (e.g. 'ENG'). The human handle the
    -- ladder and the band scope name; renames are a new code only through
    -- the service, never a silent edit that orphans history.
    code text NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_job_levels (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    -- NULL = the org-wide ladder (small orgs run one ladder); set = this
    -- family's ladder. A level never moves between ladders: storage has no
    -- update path that re-points it, the service retires and recreates.
    family_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    -- Orders rungs within one ladder (1 = entry). Equal rank inside one
    -- ladder is refused: two rungs cannot both be "the" third rung.
    rank integer NOT NULL,
    -- The gender-neutral equal-value criteria the EU directive requires,
    -- org-declared per level: [{criterion, weight}]. Storage pins the key
    -- set; the service requires at least one criterion with a weight.
    equal_value_criteria jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_pay_bands (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    -- Scope narrows family → level → employer subsidiary → location; every
    -- NULL is a wider band (org-wide when all four are NULL). Resolution
    -- picks the narrowest live band covering the employment's scope.
    family_id uuid,
    level_id uuid NOT NULL,
    employer_subsidiary_id uuid,
    location_id uuid,
    currency char(3) NOT NULL,
    basis text NOT NULL,
    min numeric(19,4) NOT NULL,
    target numeric(19,4) NOT NULL,
    max numeric(19,4) NOT NULL,
    effective_from date NOT NULL,
    -- NULL = live. A band change closes this row (effective_to = the day
    -- before the successor's effective_from) and opens a new row in one
    -- transaction — never an overwrite of a row a cycle line cited.
    effective_to date,
    -- Version this row supersedes (null = first issue). Always names a
    -- real band row of the same scope; closure guards verify.
    superseded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_comp_cycles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    -- The date the new rates take effect (the push writes
    -- labor_cost_rates effective on this date).
    effective_on date NOT NULL,
    budget_basis text NOT NULL DEFAULT 'combined',
    budget_total numeric(19,4),
    currency char(3) NOT NULL,
    guideline_kind text NOT NULL DEFAULT 'matrix',
    -- matrix: {rows: [performance bucket keys], cols: [compa-ratio
    -- quartile keys], cells: {row: {col: {min, max}}}}; formula: {expr}.
    -- Shape pinned here; the fixed-grammar evaluator lives in the service.
    guideline jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- 0193 applies_to shape: {employer_subsidiary_ids, department_ids}.
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- Read-only generated projections so governed surfaces never read raw
    -- JSON (the 0193 slots rule).
    scope_employer_subsidiary_id uuid
      GENERATED ALWAYS AS ((scope ->> 'employer_subsidiary_id')::uuid) STORED,
    scope_department_id uuid
      GENERATED ALWAYS AS ((scope ->> 'department_id')::uuid) STORED,
    revision integer NOT NULL DEFAULT 1,
    -- The Flows approval run deciding this cycle (null until submitted).
    -- Single-column FK to the runs primary key; the release hook stamps
    -- the decision back onto the cycle in the same savepoint.
    flow_run_id uuid,
    opened_at timestamp with time zone,
    approved_at timestamp with time zone,
    pushed_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_comp_cycle_budgets (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    -- Exactly one of the two is set (storage CHECK): a department
    -- envelope or a manager envelope. allocated_amount is deliberately
    -- NOT a column: it is computed at read time from the cycle's lines.
    department_id uuid,
    manager_party_id uuid,
    currency char(3) NOT NULL,
    amount numeric(19,4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_comp_cycle_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    -- SNAPSHOTTED at cycle open from the payroll-side effective wage
    -- (through the labor-costing wage rate service, never typed): a later
    -- payroll change cannot reinterpret a decided line.
    current_rate numeric(19,4) NOT NULL,
    currency char(3) NOT NULL,
    basis text NOT NULL,
    -- The band covering the employment's scope at open (null = no band
    -- covered them; the UI shows "no band", never a zero compa-ratio).
    band_id uuid,
    -- Stored at open beside the rate they derive from, for the same
    -- freeze reason as current_rate.
    compa_ratio numeric(19,10),
    -- From the latest shared review in hrm_reviews for the cycle window
    -- (null = no shared review; the guideline then resolves to its
    -- unrated row, never to a colleague's rating).
    rating_key text,
    guideline_min_pct numeric(19,6),
    guideline_max_pct numeric(19,6),
    proposed_pct numeric(19,6),
    proposed_rate numeric(19,4),
    proposed_by uuid,
    proposed_at timestamp with time zone,
    status text NOT NULL DEFAULT 'pending',
    approver_party_id uuid,
    decided_at timestamp with time zone,
    -- A proposal outside its guideline range, or a pacing-over-budget
    -- approval, MUST carry a reason: outside-guideline is allowed but
    -- flagged, never silently accepted (service rule, evidenced here).
    reason text,
    -- The labor_cost_rates row this line pushed (null = not pushed).
    -- Idempotency link: a line with this set never pushes twice.
    -- Single-column FK to the rates primary key (the baseline table
    -- carries no UNIQUE (org_id, id), which rules out a composite FK
    -- only); cross-org safety stays with RLS plus the service check
    -- that the rate row's org_id equals the cycle's.
    pushed_rate_id uuid,
    revision integer NOT NULL DEFAULT 1,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE IF NOT EXISTS public.hrm_comp_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    line_id uuid,
    kind text NOT NULL,
    actor uuid,
    reason text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.hrm_comp_statements (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    cycle_id uuid,
    period_from date NOT NULL,
    period_to date NOT NULL,
    -- Frozen at generation: current rate, band placement, employer-paid
    -- benefits, the cycle decision. Regeneration is a new row; a
    -- delivered statement is never overwritten.
    payload jsonb NOT NULL,
    -- Rendered PDF through packages/pdf (null = payload only).
    file_id uuid,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    generated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

-- position_versions gains its job-architecture link (additive): employment
-- versions read their band through the position at the as-of date — band
-- ids are never copied onto employments.
ALTER TABLE public.position_versions
  ADD COLUMN IF NOT EXISTS job_level_id uuid;

-- ---------------------------------------------------------------------------
-- Primary keys.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_families_pkey') THEN
  ALTER TABLE ONLY public.hrm_job_families ADD CONSTRAINT hrm_job_families_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_levels_pkey') THEN
  ALTER TABLE ONLY public.hrm_job_levels ADD CONSTRAINT hrm_job_levels_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_pkey') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_pkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_budgets_pkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_budgets ADD CONSTRAINT hrm_comp_cycle_budgets_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_pkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_events_pkey') THEN
  ALTER TABLE ONLY public.hrm_comp_events ADD CONSTRAINT hrm_comp_events_pkey PRIMARY KEY (id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_statements_pkey') THEN
  ALTER TABLE ONLY public.hrm_comp_statements ADD CONSTRAINT hrm_comp_statements_pkey PRIMARY KEY (id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Composite tenant identity (org_id, id) for every composite FK target.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_families_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_job_families ADD CONSTRAINT hrm_job_families_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_levels_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_job_levels ADD CONSTRAINT hrm_job_levels_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Shape CHECKs (value sets pinned in storage; transitions in the service).
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_families_code_not_blank') THEN
  ALTER TABLE ONLY public.hrm_job_families ADD CONSTRAINT hrm_job_families_code_not_blank
    CHECK (char_length(btrim(code)) > 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_families_name_not_blank') THEN
  ALTER TABLE ONLY public.hrm_job_families ADD CONSTRAINT hrm_job_families_name_not_blank
    CHECK (char_length(btrim(name)) > 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_families_code_per_org') THEN
  ALTER TABLE ONLY public.hrm_job_families ADD CONSTRAINT hrm_job_families_code_per_org UNIQUE (org_id, code); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_levels_code_not_blank') THEN
  ALTER TABLE ONLY public.hrm_job_levels ADD CONSTRAINT hrm_job_levels_code_not_blank
    CHECK (char_length(btrim(code)) > 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_levels_rank_positive') THEN
  ALTER TABLE ONLY public.hrm_job_levels ADD CONSTRAINT hrm_job_levels_rank_positive
    CHECK (rank >= 1); END IF; END $$;
-- Element-wise validation cannot live in a CHECK (no subqueries), so a
-- small immutable predicate carries it: every element is an object with a
-- criterion in the EU key set and a weight. The service additionally
-- requires at least one criterion per level.
CREATE OR REPLACE FUNCTION public.hrm_comp_criteria_valid(criteria jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $func$
  SELECT jsonb_typeof(criteria) = 'array'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(criteria) AS c(elem)
        WHERE jsonb_typeof(c.elem) <> 'object'
           OR NOT (c.elem ? 'criterion')
           OR NOT (c.elem ? 'weight')
           OR NOT (c.elem ->> 'criterion' IN ('skills', 'effort', 'responsibility', 'working_conditions'))
     )
$func$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_levels_criteria_shape') THEN
  ALTER TABLE ONLY public.hrm_job_levels ADD CONSTRAINT hrm_job_levels_criteria_shape CHECK (
    public.hrm_comp_criteria_valid(equal_value_criteria)
  ); END IF; END $$;
-- One code per ladder per org: the org-wide ladder (family NULL) and each
-- family ladder each get their own namespace (NULLs are distinct in a
-- plain unique, so the two partial indexes below carry the rule).
DO $$ BEGIN IF to_regclass('public.hrm_job_levels_orgwide_code_unique') IS NULL THEN
  CREATE UNIQUE INDEX hrm_job_levels_orgwide_code_unique
    ON public.hrm_job_levels (org_id, code) WHERE family_id IS NULL; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.hrm_job_levels_family_code_unique') IS NULL THEN
  CREATE UNIQUE INDEX hrm_job_levels_family_code_unique
    ON public.hrm_job_levels (org_id, family_id, code) WHERE family_id IS NOT NULL; END IF; END $$;
DO $$ BEGIN IF to_regclass('public.hrm_job_levels_ladder_rank_unique') IS NULL THEN
  CREATE UNIQUE INDEX hrm_job_levels_ladder_rank_unique
    ON public.hrm_job_levels (org_id, COALESCE(family_id, '00000000-0000-0000-0000-000000000000'::uuid), rank); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_basis') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_basis
    CHECK (basis IN ('annual', 'hourly')); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_ordered') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_ordered
    CHECK (min <= target AND target <= max); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_positive') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_positive
    CHECK (min > 0 AND target > 0 AND max > 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_window') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_window CHECK (
    effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    AND (effective_to IS NULL
      OR (effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
        AND effective_to >= effective_from))
  ); END IF; END $$;
-- No two versions of one scope overlap in time: the partial-unique form
-- would go blind under READ COMMITTED, so the overlap exclusion carries
-- the rule (the same reason 0192 uses GiST on position_versions).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_no_overlap') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_no_overlap EXCLUDE USING gist (
    org_id WITH =,
    COALESCE(family_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    level_id WITH =,
    COALESCE(employer_subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    currency WITH =,
    basis WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_kind') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_kind
    CHECK (kind IN ('merit', 'promotion', 'adjustment', 'cola')); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_status') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_status CHECK (
    status IN ('draft', 'open', 'in_review', 'approved', 'pushed', 'closed', 'cancelled')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_name_not_blank') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_name_not_blank
    CHECK (char_length(btrim(name)) > 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_budget_basis') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_budget_basis
    CHECK (budget_basis IN ('top_down', 'bottom_up', 'combined')); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_guideline_kind') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_guideline_kind
    CHECK (guideline_kind IN ('matrix', 'formula')); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_budget_nonneg') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_budget_nonneg
    CHECK (budget_total IS NULL OR budget_total >= 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_effective_on_finite') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_effective_on_finite CHECK (
    effective_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_revision') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_revision CHECK (revision >= 1); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_guideline_shape') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_guideline_shape CHECK (
    jsonb_typeof(guideline) = 'object'
  ); END IF; END $$;
-- The 0193 applies_to shape: only the two slot keys, each a uuid string
-- or null. The shape CHECK stays the single authority; the generated
-- columns above are readable but never written.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_scope_shape') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_scope_shape CHECK (
    jsonb_typeof(scope) = 'object'
    AND (scope - 'employer_subsidiary_id' - 'department_id') = '{}'::jsonb
    AND (NOT (scope ? 'employer_subsidiary_id')
         OR jsonb_typeof(scope -> 'employer_subsidiary_id') = 'null'
         OR (jsonb_typeof(scope -> 'employer_subsidiary_id') = 'string'
             AND scope ->> 'employer_subsidiary_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
    AND (NOT (scope ? 'department_id')
         OR jsonb_typeof(scope -> 'department_id') = 'null'
         OR (jsonb_typeof(scope -> 'department_id') = 'string'
             AND scope ->> 'department_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
  ); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_budgets_one_holder') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_budgets ADD CONSTRAINT hrm_comp_cycle_budgets_one_holder
    CHECK (num_nonnulls(department_id, manager_party_id) = 1); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_budgets_amount_nonneg') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_budgets ADD CONSTRAINT hrm_comp_cycle_budgets_amount_nonneg
    CHECK (amount >= 0); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_budgets_one_per_holder') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_budgets ADD CONSTRAINT hrm_comp_cycle_budgets_one_per_holder
    UNIQUE (cycle_id, department_id, manager_party_id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_one_per_employment') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_one_per_employment
    UNIQUE (cycle_id, employment_id); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_basis') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_basis
    CHECK (basis IN ('annual', 'hourly')); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_status') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_status CHECK (
    status IN ('pending', 'proposed', 'approved', 'rejected', 'pushed')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_proposal_paired') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_proposal_paired CHECK (
    (status = 'pending' AND proposed_pct IS NULL AND proposed_rate IS NULL)
    OR (status <> 'pending')
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_decision_paired') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_decision_paired CHECK (
    (status IN ('approved', 'rejected', 'pushed') AND approver_party_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (status IN ('pending', 'proposed'))
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_revision') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_revision CHECK (revision >= 1); END IF; END $$;
-- A pushed line always names the wage row it created (the idempotency
-- link), and only a pushed line names one: a set link on any other
-- status is a half-push that never happened.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_pushed_rate_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_pushed_rate_fkey
    FOREIGN KEY (pushed_rate_id) REFERENCES public.labor_cost_rates(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_push_paired') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_push_paired CHECK (
    (status = 'pushed' AND pushed_rate_id IS NOT NULL)
    OR (status <> 'pushed' AND pushed_rate_id IS NULL)
  ); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_events_kind') THEN
  ALTER TABLE ONLY public.hrm_comp_events ADD CONSTRAINT hrm_comp_events_kind CHECK (
    kind IN ('opened', 'proposed', 'reopened', 'approved', 'rejected',
             'budget_changed', 'pushed', 'closed', 'cancelled')
  ); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_statements_period') THEN
  ALTER TABLE ONLY public.hrm_comp_statements ADD CONSTRAINT hrm_comp_statements_period CHECK (
    period_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    AND period_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
    AND period_to >= period_from
  ); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_statements_payload_shape') THEN
  ALTER TABLE ONLY public.hrm_comp_statements ADD CONSTRAINT hrm_comp_statements_payload_shape CHECK (
    jsonb_typeof(payload) = 'object'
  ); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Tenant FKs (composite, same-org) and the org anchors.
-- ---------------------------------------------------------------------------

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_families_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_job_families ADD CONSTRAINT hrm_job_families_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_levels_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_job_levels ADD CONSTRAINT hrm_job_levels_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_job_levels_family_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_job_levels ADD CONSTRAINT hrm_job_levels_family_tenant_fkey
    FOREIGN KEY (org_id, family_id) REFERENCES public.hrm_job_families(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_family_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_family_tenant_fkey
    FOREIGN KEY (org_id, family_id) REFERENCES public.hrm_job_families(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_level_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_level_tenant_fkey
    FOREIGN KEY (org_id, level_id) REFERENCES public.hrm_job_levels(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_employer_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_employer_tenant_fkey
    FOREIGN KEY (org_id, employer_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_pay_bands_location_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_pay_bands ADD CONSTRAINT hrm_pay_bands_location_tenant_fkey
    FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_flow_run_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_flow_run_fkey
    FOREIGN KEY (flow_run_id) REFERENCES public.flow_runs(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycles_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycles ADD CONSTRAINT hrm_comp_cycles_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_budgets_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_budgets ADD CONSTRAINT hrm_comp_cycle_budgets_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_budgets_cycle_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_budgets ADD CONSTRAINT hrm_comp_cycle_budgets_cycle_tenant_fkey
    FOREIGN KEY (org_id, cycle_id) REFERENCES public.hrm_comp_cycles(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_budgets_department_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_budgets ADD CONSTRAINT hrm_comp_cycle_budgets_department_tenant_fkey
    FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id) DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_cycle_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_cycle_tenant_fkey
    FOREIGN KEY (org_id, cycle_id) REFERENCES public.hrm_comp_cycles(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_band_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_band_tenant_fkey
    FOREIGN KEY (org_id, band_id) REFERENCES public.hrm_pay_bands(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_events_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_events ADD CONSTRAINT hrm_comp_events_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_events_cycle_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_events ADD CONSTRAINT hrm_comp_events_cycle_tenant_fkey
    FOREIGN KEY (org_id, cycle_id) REFERENCES public.hrm_comp_cycles(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_events_line_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_events ADD CONSTRAINT hrm_comp_events_line_tenant_fkey
    FOREIGN KEY (org_id, line_id) REFERENCES public.hrm_comp_cycle_lines(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_statements_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_statements ADD CONSTRAINT hrm_comp_statements_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_statements_employment_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_statements ADD CONSTRAINT hrm_comp_statements_employment_tenant_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_statements_file_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_comp_statements ADD CONSTRAINT hrm_comp_statements_file_tenant_fkey
    FOREIGN KEY (org_id, file_id) REFERENCES public.files(org_id, id) ON DELETE SET NULL DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'position_versions_job_level_tenant_fkey') THEN
  ALTER TABLE ONLY public.position_versions ADD CONSTRAINT position_versions_job_level_tenant_fkey
    FOREIGN KEY (org_id, job_level_id) REFERENCES public.hrm_job_levels(org_id, id) DEFERRABLE; END IF; END $$;

-- ---------------------------------------------------------------------------
-- Append-only + terminal-immutability guards (the 0195 evidence rule).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hrm_compensation_history_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
DECLARE
  changed text[];
BEGIN
  IF TG_TABLE_NAME = 'hrm_comp_events' THEN
    -- The event ledger is evidence: updates refused on every path, deletes
    -- only on the governed amend path — record a new event instead of
    -- editing one.
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'openbooks:immutable_evidence: % rows are append-only — record a new event instead of editing one', TG_TABLE_NAME
        USING ERRCODE = '25001';
    END IF;
    IF TG_OP = 'DELETE'
       AND current_setting('openbooks.amend', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'openbooks:immutable_evidence: % rows delete only on the governed amend path', TG_TABLE_NAME
        USING ERRCODE = '25001';
    END IF;
    RETURN OLD;
  END IF;
  -- Versioned SHOULD-pay rows and decided cycle lines are history once
  -- superseded/decided: terminal rows are immutable except a pure audit
  -- touch (updated_at/updated_by), exactly like 0195 terminal rows.
  IF TG_OP = 'DELETE'
     AND current_setting('openbooks.amend', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'openbooks:immutable_evidence: % rows delete only on the governed amend path — retire by closing, never by deleting', TG_TABLE_NAME
      USING ERRCODE = '25001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- One branch per table: PL/pgSQL does not short-circuit AND, so a
    -- shared predicate touching OLD.effective_to would fail on tables
    -- without that column. Each branch names only its own columns.
    IF TG_TABLE_NAME = 'hrm_pay_bands' THEN
      IF OLD.effective_to IS NOT NULL THEN
        changed := ARRAY(
          SELECT key FROM jsonb_each(to_jsonb(NEW)) AS n(key, value)
          WHERE (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value);
        changed := ARRAY(SELECT c FROM unnest(changed) AS c WHERE c NOT IN ('updated_at', 'updated_by'));
        IF cardinality(changed) > 0 THEN
          RAISE EXCEPTION 'openbooks:immutable_evidence: a closed pay band is history — open a new version instead of editing %', array_to_string(changed, ', ')
            USING ERRCODE = '25001';
        END IF;
      END IF;
    ELSIF TG_TABLE_NAME = 'hrm_comp_cycle_lines' THEN
      IF OLD.status IN ('approved', 'rejected', 'pushed') THEN
        changed := ARRAY(
          SELECT key FROM jsonb_each(to_jsonb(NEW)) AS n(key, value)
          WHERE (to_jsonb(OLD) -> n.key) IS DISTINCT FROM n.value);
        changed := ARRAY(SELECT c FROM unnest(changed) AS c
          WHERE c NOT IN ('updated_at', 'updated_by', 'status', 'approver_party_id', 'decided_at', 'reason', 'pushed_rate_id', 'revision'));
        IF OLD.status = 'pushed' AND (to_jsonb(NEW) ->> 'status') IS DISTINCT FROM 'pushed' THEN
          RAISE EXCEPTION 'openbooks:immutable_evidence: a pushed line already moved payroll — reverse through a new cycle, never by reopening'
            USING ERRCODE = '25001';
        END IF;
        IF cardinality(changed) > 0 THEN
          RAISE EXCEPTION 'openbooks:immutable_evidence: a decided line is evidence — reopen it through the service instead of editing %', array_to_string(changed, ', ')
            USING ERRCODE = '25001';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_comp_events_immutable ON public.hrm_comp_events;
CREATE TRIGGER hrm_comp_events_immutable
  BEFORE UPDATE OR DELETE ON public.hrm_comp_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compensation_history_guard();
DROP TRIGGER IF EXISTS hrm_pay_bands_history ON public.hrm_pay_bands;
CREATE TRIGGER hrm_pay_bands_history
  BEFORE UPDATE OR DELETE ON public.hrm_pay_bands
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compensation_history_guard();
DROP TRIGGER IF EXISTS hrm_comp_cycle_lines_history ON public.hrm_comp_cycle_lines;
CREATE TRIGGER hrm_comp_cycle_lines_history
  BEFORE UPDATE OR DELETE ON public.hrm_comp_cycle_lines
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compensation_history_guard();
DROP TRIGGER IF EXISTS hrm_comp_statements_history ON public.hrm_comp_statements;
CREATE TRIGGER hrm_comp_statements_history
  BEFORE UPDATE OR DELETE ON public.hrm_comp_statements
  FOR EACH ROW EXECUTE FUNCTION public.hrm_compensation_history_guard();

-- ---------------------------------------------------------------------------
-- Tenant RLS (0177/0181 pattern): ENABLE + FORCE with org_isolation
-- USING + WITH CHECK on all eight tables. HRM stays out of the generic
-- governed-query catalog: no refresh call in this migration.
-- ---------------------------------------------------------------------------

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'hrm_job_families', 'hrm_job_levels',
    'hrm_pay_bands', 'hrm_comp_cycles', 'hrm_comp_cycle_budgets',
    'hrm_comp_cycle_lines', 'hrm_comp_events', 'hrm_comp_statements'] LOOP
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

COMMENT ON TABLE public.hrm_job_families IS
  'HRM job architecture (0221): stable craft identity per org code. Deactivation preserves history; a family with levels cannot be deleted, only retired.';
COMMENT ON TABLE public.hrm_job_levels IS
  'HRM job architecture (0221): one rung per ladder per org code, NULL family = the org-wide ladder. Rank orders the ladder; equal_value_criteria carries the org-declared gender-neutral criteria the EU directive requires.';
COMMENT ON TABLE public.hrm_pay_bands IS
  'HRM SHOULD-pay (0221): versioned min/target/max rows per scope with an overlap exclusion — a band change is a new row, never an overwrite of a row a cycle line cited. Never what anyone IS paid.';
COMMENT ON TABLE public.hrm_comp_cycles IS
  'HRM merit rounds (0221): draft, open, in_review, approved, pushed, closed (or cancelled) with the date new rates take effect, the budget basis, and the matrix-or-formula guideline evaluated by the fixed-grammar service evaluator.';
COMMENT ON TABLE public.hrm_comp_cycle_budgets IS
  'HRM cycle envelopes (0221): one amount per cycle per department-or-manager holder. The allocated figure is computed at read time from the lines, never stored.';
COMMENT ON TABLE public.hrm_comp_cycle_lines IS
  'HRM cycle decisions (0221): one row per cycle per employment with the payroll-side wage snapshotted at open, the stored compa-ratio and guideline range, and the proposal through approval lifecycle. A pushed line already moved payroll.';
COMMENT ON TABLE public.hrm_comp_events IS
  'HRM cycle evidence (0221): the append-only event ledger for every cycle transition, recorded in the same transaction as the state write. Updates refused on every path; deletes only on the governed amend path.';
COMMENT ON TABLE public.hrm_comp_statements IS
  'HRM total-rewards evidence (0221): frozen per-employment payloads with an optional rendered PDF. Regeneration is a new row; a delivered statement is never overwritten.';
COMMENT ON COLUMN public.position_versions.job_level_id IS
  'HR-12 job architecture (0221): the rung this version of the position sits on. Employment versions read their band through the position at the as-of date — band ids are never copied onto employments.';
