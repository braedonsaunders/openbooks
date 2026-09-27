-- OpenBooks forward migration 0426_usage_rating_plans_prepaid.
-- Preserve effective-dated usage prices and prepaid draw evidence by organization.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.usage_rating_plans (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  currency_code text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamptz DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT usage_rating_plans_pkey PRIMARY KEY (id),
  CONSTRAINT usage_rating_plans_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_rating_plans_org_name_unique UNIQUE (org_id, name),
  CONSTRAINT usage_rating_plans_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT usage_rating_plans_currency_valid CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT usage_rating_plans_status_valid CHECK (status IN ('active', 'retired')),
  CONSTRAINT usage_rating_plans_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

CREATE INDEX usage_rating_plans_org_status ON public.usage_rating_plans (org_id, status);

ALTER TABLE public.usage_rating_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_rating_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_rating_plans
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.usage_rating_plan_versions (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  version_no integer NOT NULL,
  status text DEFAULT 'draft' NOT NULL,
  effective_from date NOT NULL,
  spec_hash text,
  created_at timestamptz DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamptz DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT usage_rating_plan_versions_pkey PRIMARY KEY (id),
  CONSTRAINT usage_rating_plan_versions_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_rating_plan_versions_plan_version_unique UNIQUE (org_id, plan_id, version_no),
  CONSTRAINT usage_rating_plan_versions_number_positive CHECK (version_no > 0),
  CONSTRAINT usage_rating_plan_versions_status_valid CHECK (status IN ('draft', 'published')),
  CONSTRAINT usage_rating_plan_versions_publication_shape CHECK
    ((status = 'draft' AND spec_hash IS NULL) OR (status = 'published' AND spec_hash IS NOT NULL AND spec_hash ~ '^[0-9a-f]{64}$')),
  CONSTRAINT usage_rating_plan_versions_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_rating_plan_versions_plan_org_fk
    FOREIGN KEY (org_id, plan_id) REFERENCES public.usage_rating_plans(org_id, id) ON DELETE CASCADE DEFERRABLE
);

CREATE INDEX usage_rating_plan_versions_org_plan_status
  ON public.usage_rating_plan_versions (org_id, plan_id, status);

ALTER TABLE public.usage_rating_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_rating_plan_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_rating_plan_versions
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.usage_rating_bands (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  meter_id uuid NOT NULL,
  kind text NOT NULL,
  seq integer NOT NULL,
  up_to_qty numeric(28,8),
  unit_price numeric(28,8) NOT NULL,
  flat_amount numeric(19,4) DEFAULT 0 NOT NULL,
  included_qty numeric(28,8) DEFAULT 0 NOT NULL,
  package_size numeric(28,8),
  package_rounding text,
  created_at timestamptz DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamptz DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT usage_rating_bands_pkey PRIMARY KEY (id),
  CONSTRAINT usage_rating_bands_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_rating_bands_version_meter_seq_unique UNIQUE (org_id, plan_version_id, meter_id, seq),
  CONSTRAINT usage_rating_bands_kind_valid CHECK (kind IN ('graduated', 'volume', 'package', 'overage', 'commit_shortfall', 'prepaid_drawdown')),
  CONSTRAINT usage_rating_bands_seq_positive CHECK (seq > 0),
  CONSTRAINT usage_rating_bands_upper_bound_nonnegative CHECK (up_to_qty IS NULL OR up_to_qty >= 0),
  CONSTRAINT usage_rating_bands_unit_price_nonnegative CHECK (unit_price >= 0),
  CONSTRAINT usage_rating_bands_flat_amount_nonnegative CHECK (flat_amount >= 0),
  CONSTRAINT usage_rating_bands_included_qty_nonnegative CHECK (included_qty >= 0),
  CONSTRAINT usage_rating_bands_package_rounding_valid CHECK (package_rounding IS NULL OR package_rounding IN ('up', 'down')),
  CONSTRAINT usage_rating_bands_package_shape CHECK
    ((kind = 'package' AND package_size IS NOT NULL AND package_size > 0 AND package_rounding IS NOT NULL AND package_rounding IN ('up', 'down'))
      OR (kind <> 'package' AND package_size IS NULL AND package_rounding IS NULL)),
  CONSTRAINT usage_rating_bands_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_rating_bands_version_org_fk
    FOREIGN KEY (org_id, plan_version_id) REFERENCES public.usage_rating_plan_versions(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_rating_bands_meter_org_fk
    FOREIGN KEY (org_id, meter_id) REFERENCES public.usage_meters(org_id, id) DEFERRABLE
);

CREATE INDEX usage_rating_bands_meter ON public.usage_rating_bands (org_id, meter_id, plan_version_id);

ALTER TABLE public.usage_rating_bands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_rating_bands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_rating_bands
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.subscription_usage_links (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  meter_ids uuid[] NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  commit_amount numeric(19,4),
  commit_period text,
  allow_overage boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamptz DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT subscription_usage_links_pkey PRIMARY KEY (id),
  CONSTRAINT subscription_usage_links_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT subscription_usage_links_meter_set_nonempty CHECK (cardinality(meter_ids) > 0),
  CONSTRAINT subscription_usage_links_window_valid CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT subscription_usage_links_commit_pair CHECK
    ((commit_amount IS NULL AND commit_period IS NULL)
      OR (commit_amount IS NOT NULL AND commit_amount > 0 AND commit_period IS NOT NULL AND commit_period IN ('monthly', 'annual'))),
  CONSTRAINT subscription_usage_links_commit_period_valid CHECK (commit_period IS NULL OR commit_period IN ('monthly', 'annual')),
  CONSTRAINT subscription_usage_links_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT subscription_usage_links_subscription_org_fk
    FOREIGN KEY (org_id, subscription_id) REFERENCES public.subscriptions(org_id, id) DEFERRABLE,
  CONSTRAINT subscription_usage_links_customer_org_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT subscription_usage_links_version_org_fk
    FOREIGN KEY (org_id, plan_version_id) REFERENCES public.usage_rating_plan_versions(org_id, id) DEFERRABLE
);

CREATE INDEX subscription_usage_links_subscription_window
  ON public.subscription_usage_links (org_id, subscription_id, effective_from, effective_to);

ALTER TABLE public.subscription_usage_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_usage_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.subscription_usage_links
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.usage_prepaid_grants (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  source_document_line_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  currency_code text NOT NULL,
  expires_on date,
  created_at timestamptz DEFAULT now() NOT NULL,
  created_by uuid,
  CONSTRAINT usage_prepaid_grants_pkey PRIMARY KEY (id),
  CONSTRAINT usage_prepaid_grants_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_prepaid_grants_amount_positive CHECK (amount > 0),
  CONSTRAINT usage_prepaid_grants_currency_valid CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT usage_prepaid_grants_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_prepaid_grants_customer_org_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT usage_prepaid_grants_source_line_org_fk
    FOREIGN KEY (org_id, source_document_line_id) REFERENCES public.document_lines(org_id, id) DEFERRABLE
);

CREATE INDEX usage_prepaid_grants_customer_expiry ON public.usage_prepaid_grants (org_id, customer_id, expires_on);
CREATE INDEX usage_prepaid_grants_source_line ON public.usage_prepaid_grants (org_id, source_document_line_id);

ALTER TABLE public.usage_prepaid_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_prepaid_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_prepaid_grants
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.usage_prepaid_draws (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  run_id uuid,
  period_month date NOT NULL,
  amount numeric(19,4) NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT usage_prepaid_draws_pkey PRIMARY KEY (id),
  CONSTRAINT usage_prepaid_draws_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_prepaid_draws_amount_positive CHECK (amount > 0),
  CONSTRAINT usage_prepaid_draws_period_month_first CHECK (extract(day from period_month) = 1),
  CONSTRAINT usage_prepaid_draws_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_prepaid_draws_grant_org_fk
    FOREIGN KEY (org_id, grant_id) REFERENCES public.usage_prepaid_grants(org_id, id) ON DELETE CASCADE DEFERRABLE
);

CREATE UNIQUE INDEX usage_prepaid_draws_run_grant_period_unique
  ON public.usage_prepaid_draws (org_id, run_id, grant_id, period_month);
CREATE INDEX usage_prepaid_draws_grant_period
  ON public.usage_prepaid_draws (org_id, grant_id, period_month);

ALTER TABLE public.usage_prepaid_draws ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_prepaid_draws FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_prepaid_draws
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE FUNCTION public.usage_rating_published_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'usage rating plan versions must be created as drafts';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'published usage rating plan versions are immutable; publish a new version';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'published usage rating plan versions are immutable; retain the published version';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_rating_plan_versions_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.usage_rating_plan_versions
  FOR EACH ROW EXECUTE FUNCTION public.usage_rating_published_immutable_guard();

CREATE FUNCTION public.usage_rating_bands_draft_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_org uuid;
  target_version uuid;
  version_status text;
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    target_org := OLD.org_id;
    target_version := OLD.plan_version_id;
    SELECT status INTO version_status FROM public.usage_rating_plan_versions
      WHERE org_id = target_org AND id = target_version;
    IF version_status = 'published' THEN
      RAISE EXCEPTION 'bands of a published usage rating plan version are immutable; publish a new version';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO version_status FROM public.usage_rating_plan_versions
      WHERE org_id = NEW.org_id AND id = NEW.plan_version_id;
    IF version_status = 'published' THEN
      RAISE EXCEPTION 'bands of a published usage rating plan version are immutable; publish a new version';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_rating_bands_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.usage_rating_bands
  FOR EACH ROW EXECUTE FUNCTION public.usage_rating_bands_draft_only_guard();

CREATE FUNCTION public.usage_prepaid_draws_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'prepaid draw evidence is append-only';
END;
$$;

CREATE TRIGGER usage_prepaid_draws_append_only
  BEFORE UPDATE OR DELETE ON public.usage_prepaid_draws
  FOR EACH ROW EXECUTE FUNCTION public.usage_prepaid_draws_append_only_guard();

COMMENT ON TABLE public.usage_rating_plans IS
  'Organization-owned usage price lists; retired plans remain available to their existing subscription links.';
COMMENT ON TABLE public.usage_rating_plan_versions IS
  'Effective-dated rating plan revisions; publication freezes the version and its canonical band hash.';
COMMENT ON TABLE public.usage_rating_bands IS
  'Ordered, exact-decimal rating terms for one meter in a plan version.';
COMMENT ON TABLE public.subscription_usage_links IS
  'Effective-dated subscription assignments to published usage rating versions and meter sets.';
COMMENT ON TABLE public.usage_prepaid_grants IS
  'Customer usage liability created by a posted invoice line with usage-method recognition.';
COMMENT ON TABLE public.usage_prepaid_draws IS
  'Append-only usage draws against prepaid grant liabilities; remaining balances are derived.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('usage_rating_plans', '0426_usage_rating_plans_prepaid'),
  ('usage_rating_plan_versions', '0426_usage_rating_plans_prepaid'),
  ('usage_rating_bands', '0426_usage_rating_plans_prepaid'),
  ('subscription_usage_links', '0426_usage_rating_plans_prepaid'),
  ('usage_prepaid_grants', '0426_usage_rating_plans_prepaid'),
  ('usage_prepaid_draws', '0426_usage_rating_plans_prepaid')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
