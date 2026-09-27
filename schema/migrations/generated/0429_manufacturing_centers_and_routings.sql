-- OpenBooks forward migration 0429_manufacturing_centers_and_routings.
-- Add tenant-scoped manufacturing centers, effective machine rates, and routing masters.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE public.mfg_work_centers (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  subsidiary_id uuid,
  kind text NOT NULL,
  capacity_hours_per_day numeric(19,4) NOT NULL,
  efficiency_pct numeric(19,4) NOT NULL,
  department_id uuid,
  absorbs_overhead boolean NOT NULL,
  calendar_id uuid,
  is_active boolean DEFAULT true NOT NULL,
  deactivated_at timestamp with time zone,
  custom jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_work_centers_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_work_centers_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_work_centers_org_code_unique UNIQUE (org_id, code),
  CONSTRAINT mfg_work_centers_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_work_centers_subsidiary_fk
    FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_centers_department_fk
    FOREIGN KEY (org_id, department_id)
    REFERENCES public.departments(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_centers_calendar_fk
    FOREIGN KEY (calendar_id)
    REFERENCES public.schedule_calendars(id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_centers_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_work_centers_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_work_centers_kind_check
    CHECK (kind IN ('machine', 'labor', 'cell')),
  CONSTRAINT mfg_work_centers_capacity_nonnegative
    CHECK (capacity_hours_per_day >= 0),
  CONSTRAINT mfg_work_centers_efficiency_pct
    CHECK (efficiency_pct BETWEEN 0 AND 100),
  CONSTRAINT mfg_work_centers_department_required
    CHECK (kind NOT IN ('labor', 'cell') OR department_id IS NOT NULL),
  CONSTRAINT mfg_work_centers_labels_nonempty
    CHECK (length(btrim(code)) > 0 AND length(btrim(name)) > 0)
);

CREATE INDEX mfg_work_centers_org_active
  ON public.mfg_work_centers (org_id, is_active, code);

ALTER TABLE public.mfg_work_centers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_work_centers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_work_centers
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_work_center_rates (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  work_center_id uuid NOT NULL,
  machine_rate_per_hour numeric(19,4) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_work_center_rates_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_work_center_rates_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_work_center_rates_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_work_center_rates_center_fk
    FOREIGN KEY (org_id, work_center_id)
    REFERENCES public.mfg_work_centers(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_center_rates_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_work_center_rates_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_work_center_rates_nonnegative
    CHECK (machine_rate_per_hour >= 0),
  CONSTRAINT mfg_work_center_rates_valid_range
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX mfg_work_center_rates_org_center_from
  ON public.mfg_work_center_rates (org_id, work_center_id, effective_from);

ALTER TABLE ONLY public.mfg_work_center_rates
  ADD CONSTRAINT mfg_work_center_rates_no_overlap_excl
  EXCLUDE USING gist (
    org_id WITH =,
    work_center_id WITH =,
    (daterange(effective_from, effective_to, '[)')) WITH &&
  );

ALTER TABLE public.mfg_work_center_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_work_center_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_work_center_rates
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_routings (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  produced_item_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  default_issue_location_id uuid,
  default_receipt_location_id uuid,
  overhead_basis text NOT NULL,
  custom jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_routings_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_routings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_routings_org_item_version_unique
    UNIQUE (org_id, produced_item_id, version),
  CONSTRAINT mfg_routings_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_routings_item_fk
    FOREIGN KEY (org_id, produced_item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_routings_issue_location_fk
    FOREIGN KEY (org_id, default_issue_location_id)
    REFERENCES public.stock_locations(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_routings_receipt_location_fk
    FOREIGN KEY (org_id, default_receipt_location_id)
    REFERENCES public.stock_locations(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_routings_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_routings_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_routings_version_positive CHECK (version > 0),
  CONSTRAINT mfg_routings_status_check
    CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT mfg_routings_overhead_basis_check
    CHECK (overhead_basis IN ('labor_hours', 'machine_hours', 'units')),
  CONSTRAINT mfg_routings_valid_range
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT mfg_routings_labels_nonempty
    CHECK (length(btrim(code)) > 0 AND length(btrim(name)) > 0)
);

CREATE INDEX mfg_routings_org_status_item
  ON public.mfg_routings (org_id, status, produced_item_id);

ALTER TABLE ONLY public.mfg_routings
  ADD CONSTRAINT mfg_routings_active_effectivity_excl
  EXCLUDE USING gist (
    org_id WITH =,
    produced_item_id WITH =,
    (daterange(effective_from, effective_to, '[)')) WITH &&
  ) WHERE (status = 'active');

ALTER TABLE public.mfg_routings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_routings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_routings
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_routing_operations (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  routing_id uuid NOT NULL,
  sequence integer NOT NULL,
  name text NOT NULL,
  work_center_id uuid NOT NULL,
  setup_minutes numeric(19,4) NOT NULL,
  run_minutes_per_unit numeric(19,4) NOT NULL,
  labor_minutes_per_unit numeric(19,4),
  backflush_at text DEFAULT 'none'::text NOT NULL,
  quality_gate text DEFAULT 'none'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_routing_operations_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_routing_operations_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_routing_operations_routing_sequence_unique
    UNIQUE (org_id, routing_id, sequence),
  CONSTRAINT mfg_routing_operations_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_routing_operations_routing_fk
    FOREIGN KEY (org_id, routing_id)
    REFERENCES public.mfg_routings(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_routing_operations_center_fk
    FOREIGN KEY (org_id, work_center_id)
    REFERENCES public.mfg_work_centers(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_routing_operations_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_routing_operations_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_routing_operations_sequence_positive CHECK (sequence > 0),
  CONSTRAINT mfg_routing_operations_minutes_nonnegative
    CHECK (setup_minutes >= 0 AND run_minutes_per_unit >= 0
       AND (labor_minutes_per_unit IS NULL OR labor_minutes_per_unit >= 0)),
  CONSTRAINT mfg_routing_operations_consumes_time
    CHECK (setup_minutes <> 0 OR run_minutes_per_unit <> 0),
  CONSTRAINT mfg_routing_operations_backflush_check
    CHECK (backflush_at IN ('none', 'start', 'finish')),
  CONSTRAINT mfg_routing_operations_quality_gate_check
    CHECK (quality_gate IN ('none', 'measure')),
  CONSTRAINT mfg_routing_operations_name_nonempty
    CHECK (length(btrim(name)) > 0)
);

CREATE INDEX mfg_routing_operations_org_center
  ON public.mfg_routing_operations (org_id, work_center_id, routing_id);

ALTER TABLE public.mfg_routing_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_routing_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_routing_operations
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
