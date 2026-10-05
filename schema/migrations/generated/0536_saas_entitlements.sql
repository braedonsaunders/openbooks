-- OpenBooks forward migration 0536_saas_entitlements.
-- SaaS plan entitlements: a per-organization feature catalog, plan-version
-- entitlements with limits and overage policy (effective-dated, one open row
-- per version and feature), per-subscription overrides with reason and
-- expiry, and a cached resolution snapshot refreshed by the engine writers.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.saas_features (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  description text,
  feature_type text NOT NULL,
  unit text,
  meter_id uuid,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT saas_features_pkey PRIMARY KEY (id),
  CONSTRAINT saas_features_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT saas_features_org_key_unique UNIQUE (org_id, key),
  CONSTRAINT saas_features_key_nonblank CHECK (length(btrim(key)) > 0),
  CONSTRAINT saas_features_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT saas_features_type_valid CHECK (feature_type IN ('boolean', 'quantity', 'metered', 'custom')),
  CONSTRAINT saas_features_unit_scope CHECK (unit IS NULL OR feature_type IN ('quantity', 'metered')),
  CONSTRAINT saas_features_meter_scope CHECK (meter_id IS NULL OR feature_type = 'metered'),
  CONSTRAINT saas_features_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT saas_features_meter_org_fk FOREIGN KEY (org_id, meter_id) REFERENCES public.usage_meters(org_id, id) ON DELETE RESTRICT DEFERRABLE
);

CREATE INDEX saas_features_org_active ON public.saas_features (org_id, is_active);

ALTER TABLE public.saas_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_features FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.saas_features
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.saas_features IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.saas_features IS
  'SaaS feature catalog: the priced capabilities plans grant. Metered features resolve usage through the linked meter.';

CREATE TABLE public.subscription_plan_version_entitlements (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  limit_qty numeric(28,8),
  custom_value text,
  overage_policy text DEFAULT 'block' NOT NULL,
  meter_id uuid,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT subscription_plan_version_entitlements_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_plan_version_entitlements_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT subscription_plan_version_entitlements_limit_valid CHECK (limit_qty IS NULL OR limit_qty >= 0),
  CONSTRAINT subscription_plan_version_entitlements_overage_valid CHECK (overage_policy IN ('block', 'allow_and_bill', 'alert')),
  CONSTRAINT subscription_plan_version_entitlements_window_valid CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT subscription_plan_version_entitlements_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT subscription_plan_version_entitlements_version_org_fk FOREIGN KEY (org_id, plan_version_id) REFERENCES public.subscription_plan_versions(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT subscription_plan_version_entitlements_feature_org_fk FOREIGN KEY (org_id, feature_id) REFERENCES public.saas_features(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT subscription_plan_version_entitlements_meter_org_fk FOREIGN KEY (org_id, meter_id) REFERENCES public.usage_meters(org_id, id) ON DELETE RESTRICT DEFERRABLE
);

CREATE UNIQUE INDEX subscription_plan_version_entitlements_open_unique
  ON public.subscription_plan_version_entitlements (org_id, plan_version_id, feature_id)
  WHERE effective_to IS NULL;
CREATE INDEX subscription_plan_version_entitlements_version_scan
  ON public.subscription_plan_version_entitlements (org_id, plan_version_id, effective_from);

ALTER TABLE public.subscription_plan_version_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plan_version_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.subscription_plan_version_entitlements
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.subscription_plan_version_entitlements IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.subscription_plan_version_entitlements IS
  'Plan-version entitlements: the value, limit and overage policy each feature carries on a plan version. Effective-dated with one open row per version and feature, so changing a rule never reinterprets history.';

CREATE TABLE public.subscription_entitlement_overrides (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  feature_id uuid NOT NULL,
  enabled boolean,
  limit_qty numeric(28,8),
  custom_value text,
  overage_policy text,
  reason text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT subscription_entitlement_overrides_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_entitlement_overrides_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT subscription_entitlement_overrides_limit_valid CHECK (limit_qty IS NULL OR limit_qty >= 0),
  CONSTRAINT subscription_entitlement_overrides_delta_present CHECK (enabled IS NOT NULL OR limit_qty IS NOT NULL OR custom_value IS NOT NULL OR overage_policy IS NOT NULL),
  CONSTRAINT subscription_entitlement_overrides_overage_valid CHECK (overage_policy IS NULL OR overage_policy IN ('block', 'allow_and_bill', 'alert')),
  CONSTRAINT subscription_entitlement_overrides_reason_nonblank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT subscription_entitlement_overrides_window_valid CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT subscription_entitlement_overrides_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT subscription_entitlement_overrides_subscription_org_fk FOREIGN KEY (org_id, subscription_id) REFERENCES public.subscriptions(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT subscription_entitlement_overrides_feature_org_fk FOREIGN KEY (org_id, feature_id) REFERENCES public.saas_features(org_id, id) ON DELETE RESTRICT DEFERRABLE
);

CREATE UNIQUE INDEX subscription_entitlement_overrides_open_unique
  ON public.subscription_entitlement_overrides (org_id, subscription_id, feature_id)
  WHERE effective_to IS NULL;
CREATE INDEX subscription_entitlement_overrides_subscription_scan
  ON public.subscription_entitlement_overrides (org_id, subscription_id, effective_from);

ALTER TABLE public.subscription_entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_entitlement_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.subscription_entitlement_overrides
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.subscription_entitlement_overrides IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.subscription_entitlement_overrides IS
  'Per-subscription entitlement overrides: negotiated departures from the plan version with a recorded reason and an expiry. An open row wins over the plan; a null overage policy inherits the plan policy.';

CREATE TABLE public.subscription_entitlement_snapshots (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  snapshot jsonb DEFAULT '[]'::jsonb NOT NULL,
  source_hash text NOT NULL,
  resolved_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT subscription_entitlement_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_entitlement_snapshots_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT subscription_entitlement_snapshots_subscription_unique UNIQUE (org_id, subscription_id),
  CONSTRAINT subscription_entitlement_snapshots_hash_nonblank CHECK (length(btrim(source_hash)) > 0),
  CONSTRAINT subscription_entitlement_snapshots_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT subscription_entitlement_snapshots_subscription_org_fk FOREIGN KEY (org_id, subscription_id) REFERENCES public.subscriptions(org_id, id) ON DELETE CASCADE DEFERRABLE
);

ALTER TABLE public.subscription_entitlement_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_entitlement_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.subscription_entitlement_snapshots
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.subscription_entitlement_snapshots IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.subscription_entitlement_snapshots IS
  'Cached entitlement resolution per subscription. The engine refreshes the row whenever the subscription, its plan version, or an override changes; readers recompute when the source hash no longer matches.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('saas_features', '0536_saas_entitlements')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('subscription_plan_version_entitlements', '0536_saas_entitlements')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('subscription_entitlement_overrides', '0536_saas_entitlements')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('subscription_entitlement_snapshots', '0536_saas_entitlements')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
