-- OpenBooks forward migration 0431_manufacturing_planning_and_capacity.
-- Add item planning policies, frozen MRP runs, suggestions, and weekly capacity facts.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.mfg_item_policies (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  item_id uuid NOT NULL,
  supply_method text NOT NULL,
  lead_time_days integer,
  safety_stock_qty numeric(19,4) NOT NULL,
  minimum_qty numeric(19,4) NOT NULL,
  order_multiple_qty numeric(19,4) NOT NULL,
  scrap_pct_planned numeric(19,4) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_item_policies_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_item_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_item_policies_org_item_unique UNIQUE (org_id, item_id),
  CONSTRAINT mfg_item_policies_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_item_policies_item_fk
    FOREIGN KEY (org_id, item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_item_policies_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_item_policies_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_item_policies_supply_method_check
    CHECK (supply_method IN ('make', 'buy', 'transfer')),
  CONSTRAINT mfg_item_policies_lead_time_nonnegative
    CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  CONSTRAINT mfg_item_policies_quantities_nonnegative
    CHECK (safety_stock_qty >= 0 AND minimum_qty >= 0 AND order_multiple_qty >= 0),
  CONSTRAINT mfg_item_policies_scrap_pct
    CHECK (scrap_pct_planned >= 0 AND scrap_pct_planned < 100)
);

CREATE INDEX mfg_item_policies_org_supply_method
  ON public.mfg_item_policies (org_id, supply_method, item_id);

ALTER TABLE public.mfg_item_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_item_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_item_policies
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_mrp_runs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  number text NOT NULL,
  horizon_start date NOT NULL,
  horizon_end date NOT NULL,
  parameters jsonb NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  run_by uuid NOT NULL,
  ran_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_mrp_runs_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_mrp_runs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_mrp_runs_org_number_unique UNIQUE (org_id, number),
  CONSTRAINT mfg_mrp_runs_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_mrp_runs_run_by_fk
    FOREIGN KEY (run_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_mrp_runs_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_mrp_runs_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_mrp_runs_status_check
    CHECK (status IN ('draft', 'complete', 'superseded')),
  CONSTRAINT mfg_mrp_runs_horizon_valid CHECK (horizon_end > horizon_start),
  CONSTRAINT mfg_mrp_runs_parameters_object
    CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT mfg_mrp_runs_number_nonempty CHECK (length(btrim(number)) > 0)
);

CREATE INDEX mfg_mrp_runs_org_status_horizon
  ON public.mfg_mrp_runs (org_id, status, horizon_start, horizon_end);

ALTER TABLE public.mfg_mrp_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_mrp_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_mrp_runs
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_planned_orders (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(19,4) NOT NULL,
  due_date date NOT NULL,
  action text NOT NULL,
  demand_ref jsonb NOT NULL,
  status text DEFAULT 'suggested'::text NOT NULL,
  converted_ref_id uuid,
  is_expedite boolean DEFAULT false NOT NULL,
  planned_start date,
  dismiss_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_planned_orders_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_planned_orders_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_planned_orders_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_planned_orders_run_fk
    FOREIGN KEY (org_id, run_id)
    REFERENCES public.mfg_mrp_runs(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_planned_orders_item_fk
    FOREIGN KEY (org_id, item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_planned_orders_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_planned_orders_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_planned_orders_action_check
    CHECK (action IN ('make', 'buy', 'transfer')),
  CONSTRAINT mfg_planned_orders_status_check
    CHECK (status IN ('suggested', 'confirmed', 'converted', 'dismissed')),
  CONSTRAINT mfg_planned_orders_quantity_nonnegative CHECK (quantity >= 0),
  CONSTRAINT mfg_planned_orders_demand_ref_object
    CHECK (jsonb_typeof(demand_ref) = 'object'),
  CONSTRAINT mfg_planned_orders_conversion_reference
    CHECK ((status = 'converted' AND converted_ref_id IS NOT NULL)
        OR (status <> 'converted' AND converted_ref_id IS NULL)),
  CONSTRAINT mfg_planned_orders_dismiss_reason
    CHECK ((status = 'dismissed' AND dismiss_reason IS NOT NULL
            AND length(btrim(dismiss_reason)) > 0)
        OR (status <> 'dismissed' AND dismiss_reason IS NULL))
);

CREATE INDEX mfg_planned_orders_org_run_status
  ON public.mfg_planned_orders (org_id, run_id, status, due_date);

ALTER TABLE public.mfg_planned_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_planned_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_planned_orders
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_capacity_weeks (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  work_center_id uuid NOT NULL,
  week_start date NOT NULL,
  planned_hours numeric(19,4) NOT NULL,
  available_hours numeric(19,4) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_capacity_weeks_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_capacity_weeks_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_capacity_weeks_org_center_week_unique
    UNIQUE (org_id, work_center_id, week_start),
  CONSTRAINT mfg_capacity_weeks_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_capacity_weeks_center_fk
    FOREIGN KEY (org_id, work_center_id)
    REFERENCES public.mfg_work_centers(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_capacity_weeks_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_capacity_weeks_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_capacity_weeks_hours_nonnegative
    CHECK (planned_hours >= 0 AND available_hours >= 0)
);

CREATE INDEX mfg_capacity_weeks_org_week_center
  ON public.mfg_capacity_weeks (org_id, week_start, work_center_id);

ALTER TABLE public.mfg_capacity_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_capacity_weeks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_capacity_weeks
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
