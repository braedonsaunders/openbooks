-- OpenBooks forward migration 0491_sales_channels.
-- Channel-neutral storefront substrate: channel connections, effective-dated
-- posting maps, location links, the single external-identity map (absorbing
-- stripe_billing_links), and the verified inbound webhook inbox.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE public.sales_channels (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  subsidiary_id uuid,
  currency text NOT NULL,
  external_account text NOT NULL,
  secrets text,
  webhook_secret text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT sales_channels_pkey PRIMARY KEY (id),
  CONSTRAINT sales_channels_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT sales_channels_kind_valid CHECK (kind IN ('shopify')),
  CONSTRAINT sales_channels_status_valid
    CHECK (status IN ('draft', 'connecting', 'active', 'paused', 'disconnected', 'error')),
  CONSTRAINT sales_channels_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT sales_channels_currency_nonblank CHECK (length(btrim(currency)) > 0),
  CONSTRAINT sales_channels_external_account_nonblank CHECK (length(btrim(external_account)) > 0),
  CONSTRAINT sales_channels_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT sales_channels_subsidiary_tenant_fk
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id)
);

CREATE UNIQUE INDEX sales_channels_kind_account_unique
  ON public.sales_channels (org_id, kind, external_account);

ALTER TABLE public.sales_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.sales_channels
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.sales_channels IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.sales_channels IS
  'One row per connected storefront. Sealed secrets stay tenant-bound ciphertext; posting configuration lives in sales_channel_account_maps.';

CREATE TABLE public.sales_channel_account_maps (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  role text NOT NULL,
  key text NOT NULL DEFAULT '',
  account_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT sales_channel_account_maps_pkey PRIMARY KEY (id),
  CONSTRAINT sales_channel_account_maps_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT sales_channel_account_maps_role_valid CHECK (role IN
    ('gateway_clearing', 'revenue', 'discount', 'shipping_income',
     'gift_card_liability', 'sales_tax_liability', 'rounding', 'refund_clearing')),
  CONSTRAINT sales_channel_account_maps_window_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT sales_channel_account_maps_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT sales_channel_account_maps_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT sales_channel_account_maps_account_tenant_fk
    FOREIGN KEY (org_id, account_id) REFERENCES public.accounts(org_id, id),
  CONSTRAINT sales_channel_account_maps_no_overlap
    EXCLUDE USING gist (
      org_id WITH =,
      channel_id WITH =,
      role WITH =,
      key WITH =,
      (daterange(effective_from, effective_to, '[]')) WITH &&
    )
);

CREATE INDEX sales_channel_account_maps_lookup
  ON public.sales_channel_account_maps (org_id, channel_id, role, key, effective_from);

ALTER TABLE public.sales_channel_account_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_channel_account_maps FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.sales_channel_account_maps
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.sales_channel_account_maps IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.sales_channel_account_maps IS
  'Effective-dated posting configuration per channel: exactly one open row per (channel, role, key) for any date, so changing a rule never reinterprets posted history. Only storage can arbitrate the concurrent-writer race.';

CREATE TABLE public.sales_channel_locations (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  external_location_id text NOT NULL,
  external_name text NOT NULL,
  stock_location_id uuid,
  sync_inventory boolean NOT NULL DEFAULT true,
  fulfils_orders boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT sales_channel_locations_pkey PRIMARY KEY (id),
  CONSTRAINT sales_channel_locations_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT sales_channel_locations_external_id_nonblank
    CHECK (length(btrim(external_location_id)) > 0),
  CONSTRAINT sales_channel_locations_external_name_nonblank
    CHECK (length(btrim(external_name)) > 0),
  CONSTRAINT sales_channel_locations_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT sales_channel_locations_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT sales_channel_locations_stock_tenant_fk
    FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations(org_id, id)
);

CREATE UNIQUE INDEX sales_channel_locations_external_unique
  ON public.sales_channel_locations (org_id, channel_id, external_location_id);

ALTER TABLE public.sales_channel_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_channel_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.sales_channel_locations
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.sales_channel_locations IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.sales_channel_locations IS
  'Storefront location to native stock location links. An unmapped location parks orders in the channel exception queue; it never invents a stock movement.';

CREATE TABLE public.external_links (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid,
  provider text NOT NULL,
  external_account text NOT NULL,
  object_type text NOT NULL,
  external_id text NOT NULL,
  external_parent_id text,
  native_table text NOT NULL,
  native_id uuid NOT NULL,
  external_updated_at timestamp with time zone,
  last_synced_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT external_links_pkey PRIMARY KEY (id),
  CONSTRAINT external_links_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT external_links_provider_valid CHECK (provider IN ('shopify', 'stripe')),
  CONSTRAINT external_links_object_type_valid CHECK (object_type IN
    ('product', 'variant', 'customer', 'order', 'refund', 'fulfillment',
     'payout', 'location', 'gift_card', 'subscription', 'price', 'meter',
     'subscription_item')),
  CONSTRAINT external_links_native_table_valid CHECK (native_table IN
    ('items', 'item_families', 'parties', 'documents', 'stock_locations',
     'stored_value_accounts', 'subscriptions', 'subscription_items',
     'subscription_usage_links', 'usage_meters', 'usage_rating_plan_versions')),
  CONSTRAINT external_links_account_nonblank CHECK (length(btrim(external_account)) > 0),
  CONSTRAINT external_links_external_id_nonblank CHECK (length(btrim(external_id)) > 0),
  CONSTRAINT external_links_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT external_links_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX external_links_external_unique
  ON public.external_links (org_id, provider, external_account, object_type, external_id);
CREATE UNIQUE INDEX external_links_native_unique
  ON public.external_links (org_id, provider, external_account, object_type, native_id);

ALTER TABLE public.external_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_links FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.external_links
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.external_links IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.external_links IS
  'The single external-identity map: (channel, object type, external id) to one native record, unique on both sides. Channel links carry the channel; platform links such as Stripe leave channel_id null. Provider must agree with the channel kind; the engine refuses a mismatch.';

CREATE TABLE public.integration_inbound_events (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  provider text NOT NULL,
  topic text NOT NULL,
  provider_event_id text NOT NULL,
  raw_body bytea NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  error text,
  result_ref jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT integration_inbound_events_pkey PRIMARY KEY (id),
  CONSTRAINT integration_inbound_events_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT integration_inbound_events_topic_nonblank CHECK (length(btrim(topic)) > 0),
  CONSTRAINT integration_inbound_events_event_id_nonblank CHECK (length(btrim(provider_event_id)) > 0),
  CONSTRAINT integration_inbound_events_attempts_valid CHECK (attempts >= 0),
  CONSTRAINT integration_inbound_events_status_valid
    CHECK (status IN ('pending', 'processing', 'processed', 'ignored', 'failed', 'dead')),
  CONSTRAINT integration_inbound_events_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT integration_inbound_events_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX integration_inbound_events_dedupe
  ON public.integration_inbound_events (channel_id, provider_event_id);
CREATE INDEX integration_inbound_events_work_scan
  ON public.integration_inbound_events (status, next_attempt_at);

ALTER TABLE public.integration_inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_inbound_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.integration_inbound_events
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.integration_inbound_events IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.integration_inbound_events IS
  'Raw verified inbound webhook inbox. Deliveries are stored before processing, deduplicated by provider event id, and processed by a worker with retries; raw bodies may hold customer data and are never copied to sandboxes.';

-- Move every Stripe identity into the single map, then retire the old table.
-- Uniqueness carries over one to one: the old (org, account, type, stripe id)
-- and (org, account, type, native id) keys become the new external and native
-- keys with provider 'stripe'.
INSERT INTO public.external_links
  (org_id, channel_id, provider, external_account, object_type, external_id,
   external_parent_id, native_table, native_id, external_updated_at,
   last_synced_at, created_at, created_by, updated_at, updated_by)
SELECT org_id, NULL, 'stripe', stripe_account, object_type, stripe_id,
  NULL,
  CASE object_type
    WHEN 'meter' THEN 'usage_meters'
    WHEN 'price' THEN 'usage_rating_plan_versions'
    WHEN 'customer' THEN 'parties'
    WHEN 'subscription' THEN 'subscriptions'
    WHEN 'subscription_item' THEN 'subscription_usage_links'
  END,
  openbooks_id, NULL, now(), created_at, created_by, updated_at, updated_by
FROM public.stripe_billing_links;

-- The query console holds a view over the retired table; drop the view first so the table can go.
DROP VIEW IF EXISTS openbooks_query.stripe_billing_links;

DROP TABLE public.stripe_billing_links;

DELETE FROM public.openbooks_query_catalog_relations WHERE relation = 'stripe_billing_links';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('sales_channels', '0491_sales_channels'),
  ('sales_channel_account_maps', '0491_sales_channels'),
  ('sales_channel_locations', '0491_sales_channels'),
  ('external_links', '0491_sales_channels'),
  ('integration_inbound_events', '0491_sales_channels')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
