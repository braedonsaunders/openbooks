-- OpenBooks forward migration 0160_allocation_kernel.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The allocation kernel (docs/design/allocation-kernel.md): one versioned,
-- effective-dated rule model bound at three moments — entry (a document line
-- explodes into a group of child lines), post (extra lines contributed to the
-- transaction's own journal entry), period (a scheduled sweep of pooled
-- balances). Plus a driver registry, run evidence, and full lineage.
--
-- The three dormant planning-era tables (allocation_rules,
-- allocation_rule_targets, allocation_runs) never had engine, API, or UI code
-- behind them and hold no rows on any installation. They are replaced in
-- place; the migration refuses to run if any of them holds a row, so tenant
-- data can never be dropped by it.
--
-- Additive elsewhere: document_lines gains distribution stamps, journal_lines
-- gains contributor stamps (nullable, no default — O(1) on large ledgers), and
-- the scheduler outbox admits the 'allocation_run' kind. No posted history is
-- reinterpreted. The governed query catalog is widened by 0161.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- 1. Retire the dormant planning-era tables (refuse if any holds data)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.allocation_runs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'allocation_runs' AND column_name = 'definition_hash') THEN
    EXECUTE 'SELECT count(*) FROM public.allocation_runs' INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'allocation_runs holds % rows; refusing to replace the dormant table', n; END IF;
    EXECUTE 'DROP VIEW IF EXISTS openbooks_query.allocation_runs';
    EXECUTE 'DROP TABLE public.allocation_runs';
  END IF;
  IF to_regclass('public.allocation_rule_targets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'allocation_rule_targets' AND column_name = 'version_id') THEN
    EXECUTE 'SELECT count(*) FROM public.allocation_rule_targets' INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'allocation_rule_targets holds % rows; refusing to replace the dormant table', n; END IF;
    EXECUTE 'DROP VIEW IF EXISTS openbooks_query.allocation_rule_targets';
    EXECUTE 'DROP TABLE public.allocation_rule_targets';
  END IF;
  IF to_regclass('public.allocation_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'allocation_rules' AND column_name = 'mode') THEN
    EXECUTE 'SELECT count(*) FROM public.allocation_rules' INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'allocation_rules holds % rows; refusing to replace the dormant table', n; END IF;
    EXECUTE 'DROP VIEW IF EXISTS openbooks_query.allocation_rules';
    EXECUTE 'DROP TABLE public.allocation_rules';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Rule heads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allocation_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    mode text NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    current_version_id uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT allocation_rules_pkey PRIMARY KEY (id),
    CONSTRAINT allocation_rules_mode_check CHECK ((mode = ANY (ARRAY['entry'::text, 'post'::text, 'period'::text]))),
    CONSTRAINT allocation_rules_key_slug CHECK ((key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text))
);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_rules_org_id_id_unique ON public.allocation_rules USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_rules_org_key ON public.allocation_rules USING btree (org_id, key);
CREATE INDEX IF NOT EXISTS allocation_rules_org_mode ON public.allocation_rules USING btree (org_id, mode, is_active, sort_order);

-- ---------------------------------------------------------------------------
-- 3. Rule versions (immutable once published)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allocation_rule_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    version_no integer NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    book_scope text DEFAULT 'primary'::text NOT NULL,
    book_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    document_kinds jsonb,
    account_scope jsonb DEFAULT '{"kind": "any"}'::jsonb NOT NULL,
    dimension_filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    apply_policy text DEFAULT 'manual'::text NOT NULL,
    source_measure text DEFAULT 'period_activity'::text NOT NULL,
    basis_kind text DEFAULT 'fixed_percent'::text NOT NULL,
    driver_id uuid,
    driver_as_of text DEFAULT 'period'::text NOT NULL,
    basis_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    target_kind text DEFAULT 'explicit'::text NOT NULL,
    dynamic_target jsonb DEFAULT '{}'::jsonb NOT NULL,
    impact text DEFAULT 'reclass'::text NOT NULL,
    offset_account_id uuid,
    residual_policy text DEFAULT 'largest_share'::text NOT NULL,
    residual_target_id uuid,
    solve_method text DEFAULT 'sequential'::text NOT NULL,
    run_policy text DEFAULT 'manual'::text NOT NULL,
    run_offset_days integer DEFAULT 0 NOT NULL,
    approval_flow_id uuid,
    memo_template text,
    line_description_template text,
    definition_hash text,
    published_at timestamp with time zone,
    published_by uuid,
    retired_at timestamp with time zone,
    retired_by uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT allocation_rule_versions_pkey PRIMARY KEY (id),
    CONSTRAINT allocation_rule_versions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'retired'::text]))),
    CONSTRAINT allocation_rule_versions_book_scope_check CHECK ((book_scope = ANY (ARRAY['primary'::text, 'all_posting'::text, 'books'::text]))),
    CONSTRAINT allocation_rule_versions_apply_policy_check CHECK ((apply_policy = ANY (ARRAY['automatic'::text, 'suggest'::text, 'manual'::text]))),
    CONSTRAINT allocation_rule_versions_source_measure_check CHECK ((source_measure = ANY (ARRAY['period_activity'::text, 'period_end_balance'::text, 'ytd_activity'::text]))),
    CONSTRAINT allocation_rule_versions_basis_kind_check CHECK ((basis_kind = ANY (ARRAY['fixed_percent'::text, 'driver'::text, 'stepped'::text]))),
    CONSTRAINT allocation_rule_versions_driver_as_of_check CHECK ((driver_as_of = ANY (ARRAY['period'::text, 'document_date'::text, 'prior_period'::text]))),
    CONSTRAINT allocation_rule_versions_target_kind_check CHECK ((target_kind = ANY (ARRAY['explicit'::text, 'dynamic'::text]))),
    CONSTRAINT allocation_rule_versions_impact_check CHECK ((impact = ANY (ARRAY['reclass'::text, 'net_zero_pair'::text, 'report_only'::text]))),
    CONSTRAINT allocation_rule_versions_residual_policy_check CHECK ((residual_policy = ANY (ARRAY['largest_share'::text, 'first_target'::text, 'last_target'::text, 'explicit_target'::text]))),
    CONSTRAINT allocation_rule_versions_solve_method_check CHECK ((solve_method = ANY (ARRAY['sequential'::text, 'simultaneous'::text]))),
    CONSTRAINT allocation_rule_versions_run_policy_check CHECK ((run_policy = ANY (ARRAY['manual'::text, 'auto_preview'::text, 'auto_post'::text]))),
    CONSTRAINT allocation_rule_versions_effective_window CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT allocation_rule_versions_run_offset CHECK ((run_offset_days >= 0)),
    CONSTRAINT allocation_rule_versions_published_hash CHECK (((status <> 'published'::text) OR (definition_hash IS NOT NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_rule_versions_org_id_id_unique ON public.allocation_rule_versions USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_rule_versions_rule_no ON public.allocation_rule_versions USING btree (org_id, rule_id, version_no);
CREATE INDEX IF NOT EXISTS allocation_rule_versions_rule_status ON public.allocation_rule_versions USING btree (org_id, rule_id, status, effective_from);

-- ---------------------------------------------------------------------------
-- 4. Explicit targets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allocation_rule_targets (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    version_id uuid NOT NULL,
    sequence integer NOT NULL,
    target_account_id uuid,
    department_id uuid,
    location_id uuid,
    class_id uuid,
    project_id uuid,
    subsidiary_id uuid,
    extra_dims jsonb DEFAULT '{}'::jsonb NOT NULL,
    fixed_percent numeric(19,4),
    weight numeric(19,4),
    is_remainder boolean DEFAULT false NOT NULL,
    label text,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT allocation_rule_targets_pkey PRIMARY KEY (id),
    CONSTRAINT allocation_rule_targets_percent_range CHECK (((fixed_percent IS NULL) OR ((fixed_percent > (0)::numeric) AND (fixed_percent <= (100)::numeric)))),
    CONSTRAINT allocation_rule_targets_weight_nonneg CHECK (((weight IS NULL) OR (weight >= (0)::numeric)))
);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_rule_targets_org_id_id_unique ON public.allocation_rule_targets USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_rule_targets_version_seq ON public.allocation_rule_targets USING btree (org_id, version_id, sequence);

-- ---------------------------------------------------------------------------
-- 5. Driver registry + manual values
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allocation_drivers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    unit text,
    dimension text NOT NULL,
    source_kind text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT allocation_drivers_pkey PRIMARY KEY (id),
    CONSTRAINT allocation_drivers_source_kind_check CHECK ((source_kind = ANY (ARRAY['statistical_journal'::text, 'gl_activity'::text, 'gl_balance'::text, 'native_measure'::text, 'manual'::text, 'report_definition'::text]))),
    CONSTRAINT allocation_drivers_key_slug CHECK ((key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text))
);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_drivers_org_id_id_unique ON public.allocation_drivers USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_drivers_org_key ON public.allocation_drivers USING btree (org_id, key);

CREATE TABLE IF NOT EXISTS public.allocation_driver_values (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    dimension_value_id uuid NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    value numeric(19,4) NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT allocation_driver_values_pkey PRIMARY KEY (id),
    CONSTRAINT allocation_driver_values_window CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT allocation_driver_values_nonneg CHECK ((value >= (0)::numeric))
);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_driver_values_unique ON public.allocation_driver_values USING btree (org_id, driver_id, dimension_value_id, effective_from);
CREATE INDEX IF NOT EXISTS allocation_driver_values_driver ON public.allocation_driver_values USING btree (org_id, driver_id, effective_from);

-- ---------------------------------------------------------------------------
-- 6. Runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allocation_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    version_id uuid NOT NULL,
    definition_hash text NOT NULL,
    period_id uuid NOT NULL,
    book_id uuid NOT NULL,
    subsidiary_id uuid,
    status text NOT NULL,
    trigger_kind text DEFAULT 'manual'::text NOT NULL,
    source_total numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    allocated_total numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    residual numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    journal_entry_id uuid,
    reversal_entry_id uuid,
    reverses_run_id uuid,
    superseded_by_run_id uuid,
    computation jsonb DEFAULT '{}'::jsonb NOT NULL,
    fingerprint text,
    error text,
    flow_run_id uuid,
    requested_by uuid,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT allocation_runs_pkey PRIMARY KEY (id),
    CONSTRAINT allocation_runs_status_check CHECK ((status = ANY (ARRAY['previewed'::text, 'pending_approval'::text, 'posted'::text, 'reversed'::text, 'failed'::text, 'superseded'::text]))),
    CONSTRAINT allocation_runs_trigger_kind_check CHECK ((trigger_kind = ANY (ARRAY['manual'::text, 'scheduled'::text, 'close_automation'::text, 'rerun'::text])))
);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_runs_org_id_id_unique ON public.allocation_runs USING btree (org_id, id);
CREATE INDEX IF NOT EXISTS allocation_runs_rule_period ON public.allocation_runs USING btree (org_id, rule_id, period_id, book_id);
CREATE INDEX IF NOT EXISTS allocation_runs_status ON public.allocation_runs USING btree (org_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS allocation_runs_one_posted ON public.allocation_runs USING btree (org_id, rule_id, period_id, book_id, COALESCE(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = 'posted'::text);

-- ---------------------------------------------------------------------------
-- 7. Lineage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allocation_lineage (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    mode text NOT NULL,
    rule_id uuid NOT NULL,
    version_id uuid NOT NULL,
    definition_hash text NOT NULL,
    run_id uuid,
    document_id uuid,
    journal_entry_id uuid,
    journal_line_id uuid,
    source_journal_line_id uuid,
    source_document_line_id uuid,
    target_document_line_id uuid,
    driver_id uuid,
    driver_value numeric(19,4),
    driver_total numeric(19,4),
    share numeric(19,10),
    amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    residual numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT allocation_lineage_pkey PRIMARY KEY (id),
    CONSTRAINT allocation_lineage_mode_check CHECK ((mode = ANY (ARRAY['entry'::text, 'post'::text, 'period'::text]))),
    CONSTRAINT allocation_lineage_anchor CHECK (((run_id IS NOT NULL) OR (document_id IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS allocation_lineage_entry ON public.allocation_lineage USING btree (org_id, journal_entry_id);
CREATE INDEX IF NOT EXISTS allocation_lineage_run ON public.allocation_lineage USING btree (org_id, run_id);
CREATE INDEX IF NOT EXISTS allocation_lineage_rule ON public.allocation_lineage USING btree (org_id, rule_id, created_at);
CREATE INDEX IF NOT EXISTS allocation_lineage_document ON public.allocation_lineage USING btree (org_id, document_id);

-- ---------------------------------------------------------------------------
-- 8. Tenant-coherent foreign keys (composite where the parent exposes (org_id, id))
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- versions
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_versions_rule_id_fkey') THEN
    ALTER TABLE public.allocation_rule_versions ADD CONSTRAINT allocation_rule_versions_rule_id_fkey
      FOREIGN KEY (org_id, rule_id) REFERENCES public.allocation_rules(org_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_versions_offset_account_id_fkey') THEN
    ALTER TABLE public.allocation_rule_versions ADD CONSTRAINT allocation_rule_versions_offset_account_id_fkey
      FOREIGN KEY (org_id, offset_account_id) REFERENCES public.accounts(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_versions_driver_id_fkey') THEN
    ALTER TABLE public.allocation_rule_versions ADD CONSTRAINT allocation_rule_versions_driver_id_fkey
      FOREIGN KEY (org_id, driver_id) REFERENCES public.allocation_drivers(org_id, id);
  END IF;
  -- rule head → current version (deferrable: the head is created before its first version)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rules_current_version_id_fkey') THEN
    ALTER TABLE public.allocation_rules ADD CONSTRAINT allocation_rules_current_version_id_fkey
      FOREIGN KEY (org_id, current_version_id) REFERENCES public.allocation_rule_versions(org_id, id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  -- targets
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_targets_version_id_fkey') THEN
    ALTER TABLE public.allocation_rule_targets ADD CONSTRAINT allocation_rule_targets_version_id_fkey
      FOREIGN KEY (org_id, version_id) REFERENCES public.allocation_rule_versions(org_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_targets_target_account_id_fkey') THEN
    ALTER TABLE public.allocation_rule_targets ADD CONSTRAINT allocation_rule_targets_target_account_id_fkey
      FOREIGN KEY (org_id, target_account_id) REFERENCES public.accounts(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_targets_department_id_fkey') THEN
    ALTER TABLE public.allocation_rule_targets ADD CONSTRAINT allocation_rule_targets_department_id_fkey
      FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_targets_location_id_fkey') THEN
    ALTER TABLE public.allocation_rule_targets ADD CONSTRAINT allocation_rule_targets_location_id_fkey
      FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_targets_class_id_fkey') THEN
    ALTER TABLE public.allocation_rule_targets ADD CONSTRAINT allocation_rule_targets_class_id_fkey
      FOREIGN KEY (class_id) REFERENCES public.classes(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_targets_project_id_fkey') THEN
    ALTER TABLE public.allocation_rule_targets ADD CONSTRAINT allocation_rule_targets_project_id_fkey
      FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_rule_targets_subsidiary_id_fkey') THEN
    ALTER TABLE public.allocation_rule_targets ADD CONSTRAINT allocation_rule_targets_subsidiary_id_fkey
      FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id);
  END IF;
  -- driver values
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_driver_values_driver_id_fkey') THEN
    ALTER TABLE public.allocation_driver_values ADD CONSTRAINT allocation_driver_values_driver_id_fkey
      FOREIGN KEY (org_id, driver_id) REFERENCES public.allocation_drivers(org_id, id) ON DELETE CASCADE;
  END IF;
  -- runs
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_rule_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_rule_id_fkey
      FOREIGN KEY (org_id, rule_id) REFERENCES public.allocation_rules(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_version_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_version_id_fkey
      FOREIGN KEY (org_id, version_id) REFERENCES public.allocation_rule_versions(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_period_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_period_id_fkey
      FOREIGN KEY (org_id, period_id) REFERENCES public.accounting_periods(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_book_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_book_id_fkey
      FOREIGN KEY (book_id) REFERENCES public.accounting_books(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_subsidiary_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_subsidiary_id_fkey
      FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_journal_entry_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_journal_entry_id_fkey
      FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_reversal_entry_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_reversal_entry_id_fkey
      FOREIGN KEY (org_id, reversal_entry_id) REFERENCES public.journal_entries(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_reverses_run_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_reverses_run_id_fkey
      FOREIGN KEY (org_id, reverses_run_id) REFERENCES public.allocation_runs(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_runs_superseded_by_run_id_fkey') THEN
    ALTER TABLE public.allocation_runs ADD CONSTRAINT allocation_runs_superseded_by_run_id_fkey
      FOREIGN KEY (org_id, superseded_by_run_id) REFERENCES public.allocation_runs(org_id, id);
  END IF;
  -- lineage
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_rule_id_fkey') THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_rule_id_fkey
      FOREIGN KEY (org_id, rule_id) REFERENCES public.allocation_rules(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_version_id_fkey') THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_version_id_fkey
      FOREIGN KEY (org_id, version_id) REFERENCES public.allocation_rule_versions(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_run_id_fkey') THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_run_id_fkey
      FOREIGN KEY (org_id, run_id) REFERENCES public.allocation_runs(org_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_document_id_fkey') THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_document_id_fkey
      FOREIGN KEY (org_id, document_id) REFERENCES public.documents(org_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_journal_entry_id_fkey') THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_journal_entry_id_fkey
      FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_journal_line_id_fkey') THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_journal_line_id_fkey
      FOREIGN KEY (journal_line_id) REFERENCES public.journal_lines(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_driver_id_fkey') THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_driver_id_fkey
      FOREIGN KEY (org_id, driver_id) REFERENCES public.allocation_drivers(org_id, id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Row-level security on every new table
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rel text;
BEGIN
  FOREACH rel IN ARRAY ARRAY[
    'allocation_rules', 'allocation_rule_versions', 'allocation_rule_targets',
    'allocation_drivers', 'allocation_driver_values', 'allocation_runs', 'allocation_lineage'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', rel);
    EXECUTE format('ALTER TABLE ONLY public.%I FORCE ROW LEVEL SECURITY', rel);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = rel AND policyname = 'org_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY org_isolation ON public.%I USING (((current_setting(''app.bypass_rls''::text, true) = ''on''::text) OR ((org_id)::text = current_setting(''app.current_org''::text, true)))) WITH CHECK (((current_setting(''app.bypass_rls''::text, true) = ''on''::text) OR ((org_id)::text = current_setting(''app.current_org''::text, true))))',
        rel);
    END IF;
    EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS %L', rel, 'openbooks:org_isolation:v1');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Published versions are frozen (definition columns immutable; only
--     status/retired_* and the audit stamp may change afterwards)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.allocation_rule_version_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status = 'draft' then
    return new;
  end if;
  if old.status = 'retired' then
    raise exception 'allocation rule version % is retired and immutable', old.id;
  end if;
  -- published: allow draft→published transition already applied; now lock the definition
  if new.status not in ('published', 'retired') then
    raise exception 'allocation rule version % is published; it can only be retired', old.id;
  end if;
  if row(new.rule_id, new.version_no, new.effective_from, new.effective_to, new.book_scope, new.book_ids,
         new.document_kinds, new.account_scope, new.dimension_filters, new.apply_policy, new.source_measure,
         new.basis_kind, new.driver_id, new.driver_as_of, new.basis_config, new.target_kind, new.dynamic_target,
         new.impact, new.offset_account_id, new.residual_policy, new.residual_target_id, new.solve_method,
         new.memo_template, new.line_description_template, new.definition_hash, new.published_at, new.published_by)
     is distinct from
     row(old.rule_id, old.version_no, old.effective_from, old.effective_to, old.book_scope, old.book_ids,
         old.document_kinds, old.account_scope, old.dimension_filters, old.apply_policy, old.source_measure,
         old.basis_kind, old.driver_id, old.driver_as_of, old.basis_config, old.target_kind, old.dynamic_target,
         old.impact, old.offset_account_id, old.residual_policy, old.residual_target_id, old.solve_method,
         old.memo_template, old.line_description_template, old.definition_hash, old.published_at, old.published_by)
  then
    raise exception 'allocation rule version % is published; its definition is immutable (retire it and publish a new version)', old.id;
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS allocation_rule_version_guard ON public.allocation_rule_versions;
CREATE TRIGGER allocation_rule_version_guard BEFORE UPDATE ON public.allocation_rule_versions
  FOR EACH ROW EXECUTE FUNCTION public.allocation_rule_version_guard();

CREATE OR REPLACE FUNCTION public.allocation_rule_target_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
  v_version uuid;
begin
  v_version := coalesce(new.version_id, old.version_id);
  select status into v_status from public.allocation_rule_versions where id = v_version;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'allocation rule version % is %; its targets are immutable', v_version, v_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS allocation_rule_target_guard ON public.allocation_rule_targets;
CREATE TRIGGER allocation_rule_target_guard BEFORE INSERT OR UPDATE OR DELETE ON public.allocation_rule_targets
  FOR EACH ROW EXECUTE FUNCTION public.allocation_rule_target_guard();

-- ---------------------------------------------------------------------------
-- 11. Stamps on existing tables
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_lines ADD COLUMN IF NOT EXISTS distribution_group_id uuid;
ALTER TABLE public.document_lines ADD COLUMN IF NOT EXISTS distribution_rule_id uuid;
ALTER TABLE public.document_lines ADD COLUMN IF NOT EXISTS distribution_version_id uuid;
ALTER TABLE public.document_lines ADD COLUMN IF NOT EXISTS distribution_locked boolean DEFAULT false NOT NULL;
CREATE INDEX IF NOT EXISTS document_lines_distribution_group ON public.document_lines USING btree (org_id, distribution_group_id) WHERE (distribution_group_id IS NOT NULL);

ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS contributor_kind text;
ALTER TABLE public.journal_lines ADD COLUMN IF NOT EXISTS contributor_ref uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_contributor_kind_check') THEN
    ALTER TABLE public.journal_lines ADD CONSTRAINT journal_lines_contributor_kind_check
      CHECK ((contributor_kind IS NULL) OR (contributor_kind = ANY (ARRAY['rule'::text, 'script'::text, 'app'::text, 'intercompany'::text])));
  END IF;
END $$;

-- scheduler outbox admits allocation runs
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduler_outbox_kind') THEN
    ALTER TABLE public.scheduler_outbox DROP CONSTRAINT scheduler_outbox_kind;
  END IF;
  ALTER TABLE public.scheduler_outbox ADD CONSTRAINT scheduler_outbox_kind
    CHECK ((kind = ANY (ARRAY['dunning'::text, 'subscription_billing'::text, 'property_billing'::text, 'fx_providers'::text, 'approval_escalation'::text, 'flow_email'::text, 'allocation_run'::text])));
END $$;
