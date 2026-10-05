-- OpenBooks forward migration 0523_shopify_connector.
-- Match queue for the Shopify catalog import: one row per Shopify product or
-- variant with its match state. Match decisions themselves stay in
-- external_links; this table is the operator's work queue and rebuilds from
-- the storefront on re-import, so sandboxes skip it like the inbox.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.shopify_catalog_entries (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  object_type text NOT NULL,
  external_id text NOT NULL,
  external_parent_id text,
  title text NOT NULL,
  sku text,
  barcode text,
  price_minor bigint,
  currency text NOT NULL DEFAULT ''::text,
  option_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  shopify_updated_at timestamp with time zone,
  status text NOT NULL DEFAULT 'queued'::text,
  native_table text,
  native_id uuid,
  ignore_reason text,
  proposal jsonb,
  last_synced_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT shopify_catalog_entries_pkey PRIMARY KEY (id),
  CONSTRAINT shopify_catalog_entries_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT shopify_catalog_entries_object_valid
    CHECK (object_type IN ('product', 'variant')),
  CONSTRAINT shopify_catalog_entries_status_valid
    CHECK (status IN ('queued', 'matched', 'ignored')),
  CONSTRAINT shopify_catalog_entries_external_id_nonblank CHECK (length(btrim(external_id)) > 0),
  CONSTRAINT shopify_catalog_entries_title_nonblank CHECK (length(btrim(title)) > 0),
  CONSTRAINT shopify_catalog_entries_match_valid
    CHECK ((status = 'matched') = (native_table IS NOT NULL AND native_id IS NOT NULL)),
  CONSTRAINT shopify_catalog_entries_native_valid
    CHECK (native_table IS NULL OR native_table IN ('items', 'item_families')),
  CONSTRAINT shopify_catalog_entries_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT shopify_catalog_entries_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX shopify_catalog_entries_external_unique
  ON public.shopify_catalog_entries (org_id, channel_id, external_id);
CREATE INDEX shopify_catalog_entries_queue
  ON public.shopify_catalog_entries (org_id, channel_id, status);

ALTER TABLE public.shopify_catalog_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopify_catalog_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.shopify_catalog_entries
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.shopify_catalog_entries IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.shopify_catalog_entries IS
  'Shopify catalog match queue: one row per storefront product or variant with its SKU, barcode, price and match state. Decisions write to external_links; re-import rebuilds these rows.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('shopify_catalog_entries', '0523_shopify_connector')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
