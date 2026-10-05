-- OpenBooks forward migration 0510_billing_history_import.
-- Admit billing-platform history import (Chargebee, Recurly, Maxio, Zuora)
-- into the single external-identity map and track each import run.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The identity map admits one provider vocabulary; widening it is additive,
-- so every existing link keeps satisfying its constraint.
ALTER TABLE public.external_links DROP CONSTRAINT external_links_provider_valid;
ALTER TABLE public.external_links ADD CONSTRAINT external_links_provider_valid CHECK (provider IN
  ('shopify', 'stripe', 'chargebee', 'recurly', 'maxio', 'zuora'));

ALTER TABLE public.external_links DROP CONSTRAINT external_links_object_type_valid;
ALTER TABLE public.external_links ADD CONSTRAINT external_links_object_type_valid CHECK (object_type IN
  ('product', 'variant', 'customer', 'order', 'refund', 'fulfillment',
   'payout', 'location', 'gift_card', 'subscription', 'price', 'meter',
   'subscription_item', 'invoice', 'credit_note', 'payment', 'coupon'));

ALTER TABLE public.external_links DROP CONSTRAINT external_links_native_table_valid;
ALTER TABLE public.external_links ADD CONSTRAINT external_links_native_table_valid CHECK (native_table IN
  ('items', 'item_families', 'parties', 'documents', 'stock_locations',
   'stored_value_accounts', 'subscriptions', 'subscription_items',
   'subscription_usage_links', 'usage_meters', 'usage_rating_plan_versions',
   'promotions'));

-- One row per billing-history import execution. Run rows are evidence of what
-- the operator imported, mapped and reconciled; imported objects stay
-- idempotent through external_links, so re-running creates a new run row and
-- never duplicates a native record. The jsonb columns carry only
-- configuration, aggregate counts and aggregate reconciliation figures keyed
-- by external id — never customer names or emails — so the table holds no
-- personal data. Per-customer differences are recomputed on demand for the
-- reconciliation view and never persisted.
CREATE TABLE public.billing_import_runs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_account text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  mode text NOT NULL DEFAULT 'post_historical',
  cutover_on date,
  history_depth_months integer,
  config jsonb NOT NULL DEFAULT '{}',
  counts jsonb NOT NULL DEFAULT '{}',
  cursor jsonb NOT NULL DEFAULT '{}',
  reconciliation jsonb,
  last_error text,
  finished_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT billing_import_runs_pkey PRIMARY KEY (id),
  CONSTRAINT billing_import_runs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT billing_import_runs_provider_valid CHECK (provider IN
    ('chargebee', 'recurly', 'maxio', 'zuora')),
  CONSTRAINT billing_import_runs_account_nonblank CHECK (length(btrim(external_account)) > 0),
  CONSTRAINT billing_import_runs_status_valid CHECK (status IN
    ('draft', 'preflight', 'ready', 'running', 'reconciling', 'complete', 'failed')),
  CONSTRAINT billing_import_runs_mode_valid CHECK (mode IN
    ('post_historical', 'opening_balances')),
  CONSTRAINT billing_import_runs_depth_valid CHECK
    (history_depth_months IS NULL OR history_depth_months > 0),
  CONSTRAINT billing_import_runs_finished_valid CHECK
    ((status IN ('complete', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX billing_import_runs_org_provider_account
  ON public.billing_import_runs (org_id, provider, external_account, created_at);

ALTER TABLE public.billing_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.billing_import_runs
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.billing_import_runs IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.billing_import_runs IS
  'Billing-platform history import runs: provider connection, mapping configuration, per-object counts, incremental cursor and aggregate reconciliation. Native records stay idempotent through external_links.';

insert into public.openbooks_query_catalog_relations (relation, added_in)
 values ('billing_import_runs', '0510_billing_history_import')
 on conflict (relation) do nothing; -- expected on replay
select public.openbooks_refresh_query_catalog();
