-- OpenBooks forward migration 0508_demand_forecasting.
-- Statistical demand planning for stocked items: per-item planning policy,
-- forecast runs with weekly item-by-location forecasts, reviewable purchase
-- and transfer suggestions, and operator period overrides with reasons.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.demand_item_policies (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  item_id uuid NOT NULL,
  lead_time_days integer,
  review_cycle_days integer,
  service_level numeric(5,4),
  moq_qty numeric(19,4),
  case_pack_qty numeric(19,4),
  preferred_supplier_id uuid,
  forecast_method text,
  history_weeks integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT demand_item_policies_pkey PRIMARY KEY (id),
  CONSTRAINT demand_item_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT demand_item_policies_org_item_unique UNIQUE (org_id, item_id),
  CONSTRAINT demand_item_policies_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT demand_item_policies_item_fk
    FOREIGN KEY (org_id, item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT demand_item_policies_supplier_fk
    FOREIGN KEY (org_id, preferred_supplier_id)
    REFERENCES public.parties(org_id, id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_item_policies_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_item_policies_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_item_policies_lead_time_nonnegative
    CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  CONSTRAINT demand_item_policies_review_cycle_nonnegative
    CHECK (review_cycle_days IS NULL OR review_cycle_days >= 0),
  CONSTRAINT demand_item_policies_service_level_range
    CHECK (service_level IS NULL OR (service_level >= 0.5 AND service_level <= 0.9999)),
  CONSTRAINT demand_item_policies_quantities_nonnegative
    CHECK ((moq_qty IS NULL OR moq_qty >= 0) AND (case_pack_qty IS NULL OR case_pack_qty > 0)),
  CONSTRAINT demand_item_policies_method_valid
    CHECK (forecast_method IS NULL
      OR forecast_method IN ('auto', 'seasonal', 'intermittent', 'average')),
  CONSTRAINT demand_item_policies_history_weeks_range
    CHECK (history_weeks IS NULL OR (history_weeks >= 4 AND history_weeks <= 156))
);

ALTER TABLE public.demand_item_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demand_item_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.demand_item_policies
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.demand_item_policies IS 'openbooks:org_isolation:v1';

CREATE TABLE public.demand_forecast_runs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  number text NOT NULL,
  as_of date NOT NULL,
  horizon_weeks integer NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  parameters jsonb NOT NULL,
  run_by uuid NOT NULL,
  ran_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT demand_forecast_runs_pkey PRIMARY KEY (id),
  CONSTRAINT demand_forecast_runs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT demand_forecast_runs_org_number_unique UNIQUE (org_id, number),
  CONSTRAINT demand_forecast_runs_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT demand_forecast_runs_run_by_fk
    FOREIGN KEY (run_by) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT demand_forecast_runs_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_forecast_runs_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_forecast_runs_status_check
    CHECK (status IN ('draft', 'complete', 'superseded')),
  CONSTRAINT demand_forecast_runs_horizon_valid
    CHECK (horizon_weeks >= 1 AND horizon_weeks <= 52),
  CONSTRAINT demand_forecast_runs_parameters_object
    CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT demand_forecast_runs_number_nonempty CHECK (length(btrim(number)) > 0)
);

CREATE INDEX demand_forecast_runs_org_status_as_of
  ON public.demand_forecast_runs (org_id, status, as_of);

ALTER TABLE public.demand_forecast_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demand_forecast_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.demand_forecast_runs
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.demand_forecast_runs IS 'openbooks:org_isolation:v1';

CREATE TABLE public.demand_forecasts (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  stock_location_id uuid NOT NULL,
  period_start date NOT NULL,
  period_grain text NOT NULL,
  forecast_qty numeric(19,4) NOT NULL,
  lower_qty numeric(19,4) NOT NULL,
  upper_qty numeric(19,4) NOT NULL,
  method text NOT NULL,
  explanation jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT demand_forecasts_pkey PRIMARY KEY (id),
  CONSTRAINT demand_forecasts_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT demand_forecasts_org_run_item_location_period_unique
    UNIQUE (org_id, run_id, item_id, stock_location_id, period_start),
  CONSTRAINT demand_forecasts_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT demand_forecasts_run_fk
    FOREIGN KEY (org_id, run_id)
    REFERENCES public.demand_forecast_runs(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT demand_forecasts_item_fk
    FOREIGN KEY (org_id, item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT demand_forecasts_location_fk
    FOREIGN KEY (org_id, stock_location_id)
    REFERENCES public.stock_locations(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT demand_forecasts_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_forecasts_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_forecasts_grain_valid
    CHECK (period_grain IN ('week', 'month')),
  CONSTRAINT demand_forecasts_quantities_nonnegative
    CHECK (forecast_qty >= 0 AND lower_qty >= 0 AND upper_qty >= 0),
  CONSTRAINT demand_forecasts_band_valid
    CHECK (lower_qty <= forecast_qty AND forecast_qty <= upper_qty),
  CONSTRAINT demand_forecasts_method_valid
    CHECK (method IN ('seasonal_additive', 'seasonal_multiplicative',
      'croston_sba', 'moving_average', 'override')),
  CONSTRAINT demand_forecasts_explanation_object
    CHECK (jsonb_typeof(explanation) = 'object')
);

CREATE INDEX demand_forecasts_org_item_location_period
  ON public.demand_forecasts (org_id, item_id, stock_location_id, period_start);

ALTER TABLE public.demand_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demand_forecasts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.demand_forecasts
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.demand_forecasts IS 'openbooks:org_isolation:v1';

CREATE TABLE public.demand_plan_suggestions (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  item_id uuid NOT NULL,
  stock_location_id uuid NOT NULL,
  action text NOT NULL,
  quantity numeric(19,4) NOT NULL,
  due_date date NOT NULL,
  planned_start date,
  forecast_qty numeric(19,4) NOT NULL,
  projected_supply numeric(19,4) NOT NULL,
  days_of_cover numeric(19,4),
  status text DEFAULT 'suggested'::text NOT NULL,
  converted_ref_id uuid,
  dismiss_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT demand_plan_suggestions_pkey PRIMARY KEY (id),
  CONSTRAINT demand_plan_suggestions_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT demand_plan_suggestions_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT demand_plan_suggestions_run_fk
    FOREIGN KEY (org_id, run_id)
    REFERENCES public.demand_forecast_runs(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT demand_plan_suggestions_item_fk
    FOREIGN KEY (org_id, item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT demand_plan_suggestions_location_fk
    FOREIGN KEY (org_id, stock_location_id)
    REFERENCES public.stock_locations(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT demand_plan_suggestions_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_plan_suggestions_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_plan_suggestions_action_valid
    CHECK (action IN ('buy', 'transfer')),
  CONSTRAINT demand_plan_suggestions_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT demand_plan_suggestions_forecast_nonnegative
    CHECK (forecast_qty >= 0),
  CONSTRAINT demand_plan_suggestions_cover_nonnegative
    CHECK (days_of_cover IS NULL OR days_of_cover >= 0),
  CONSTRAINT demand_plan_suggestions_status_valid
    CHECK (status IN ('suggested', 'confirmed', 'converted', 'dismissed')),
  CONSTRAINT demand_plan_suggestions_dismiss_reason
    CHECK ((status <> 'dismissed' AND dismiss_reason IS NULL)
      OR (status = 'dismissed' AND dismiss_reason IS NOT NULL
        AND length(btrim(dismiss_reason)) BETWEEN 5 AND 500))
);

CREATE INDEX demand_plan_suggestions_org_run_status
  ON public.demand_plan_suggestions (org_id, run_id, status);

ALTER TABLE public.demand_plan_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demand_plan_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.demand_plan_suggestions
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.demand_plan_suggestions IS 'openbooks:org_isolation:v1';

CREATE TABLE public.demand_forecast_overrides (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  item_id uuid NOT NULL,
  stock_location_id uuid NOT NULL,
  period_start date NOT NULL,
  quantity numeric(19,4) NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT demand_forecast_overrides_pkey PRIMARY KEY (id),
  CONSTRAINT demand_forecast_overrides_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT demand_forecast_overrides_org_item_location_period_unique
    UNIQUE (org_id, item_id, stock_location_id, period_start),
  CONSTRAINT demand_forecast_overrides_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT demand_forecast_overrides_item_fk
    FOREIGN KEY (org_id, item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT demand_forecast_overrides_location_fk
    FOREIGN KEY (org_id, stock_location_id)
    REFERENCES public.stock_locations(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT demand_forecast_overrides_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_forecast_overrides_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT demand_forecast_overrides_quantity_nonnegative
    CHECK (quantity >= 0),
  CONSTRAINT demand_forecast_overrides_reason_valid
    CHECK (length(btrim(reason)) BETWEEN 5 AND 500)
);

ALTER TABLE public.demand_forecast_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demand_forecast_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.demand_forecast_overrides
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.demand_forecast_overrides IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES
  ('demand_item_policies','0508'),
  ('demand_forecast_runs','0508'),
  ('demand_forecasts','0508'),
  ('demand_plan_suggestions','0508'),
  ('demand_forecast_overrides','0508')
  on conflict (relation) do nothing; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
