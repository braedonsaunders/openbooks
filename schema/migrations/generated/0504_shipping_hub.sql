-- OpenBooks forward migration 0504_shipping_hub.
-- Native carrier hub: aggregator accounts holding sealed credentials, package
-- presets, per-organization posting and rating defaults, shipment labels with
-- their cost evidence, short-lived rate quotes, and carrier billing
-- adjustments. Additive only: six new tables plus five nullable shipping
-- columns on items. No existing row is read, rewritten, or deleted.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.shipping_accounts (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  name text NOT NULL,
  provider text NOT NULL,
  mode text NOT NULL DEFAULT 'test',
  status text NOT NULL DEFAULT 'active',
  is_default boolean NOT NULL DEFAULT false,
  secrets text,
  webhook_secret text,
  last_error text,
  last_checked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT shipping_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT shipping_accounts_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT shipping_accounts_org_name_unique UNIQUE (org_id, name),
  CONSTRAINT shipping_accounts_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT shipping_accounts_provider_valid CHECK (provider IN ('easypost', 'shippo')),
  CONSTRAINT shipping_accounts_mode_valid CHECK (mode IN ('test', 'live')),
  CONSTRAINT shipping_accounts_status_valid CHECK (status IN ('active', 'disabled', 'error'))
);
CREATE UNIQUE INDEX shipping_accounts_org_default_unique ON public.shipping_accounts (org_id) WHERE is_default;
ALTER TABLE public.shipping_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.shipping_accounts
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.shipping_accounts IS 'openbooks:org_isolation:v1';

CREATE TABLE public.package_presets (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  length numeric(19, 4),
  width numeric(19, 4),
  height numeric(19, 4),
  dim_unit text NOT NULL DEFAULT 'cm',
  weight numeric(19, 4),
  weight_unit text NOT NULL DEFAULT 'kg',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT package_presets_pkey PRIMARY KEY (id),
  CONSTRAINT package_presets_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT package_presets_org_name_unique UNIQUE (org_id, name),
  CONSTRAINT package_presets_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT package_presets_dims_positive CHECK (
    (length IS NULL OR length > 0) AND (width IS NULL OR width > 0) AND (height IS NULL OR height > 0)),
  CONSTRAINT package_presets_dim_unit_valid CHECK (dim_unit IN ('cm', 'in')),
  CONSTRAINT package_presets_weight_positive CHECK (weight IS NULL OR weight > 0),
  CONSTRAINT package_presets_weight_unit_valid CHECK (weight_unit IN ('g', 'kg', 'oz', 'lb'))
);
CREATE UNIQUE INDEX package_presets_org_default_unique ON public.package_presets (org_id) WHERE is_default;
ALTER TABLE public.package_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_presets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.package_presets
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.package_presets IS 'openbooks:org_isolation:v1';

CREATE TABLE public.shipping_settings (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  shipping_expense_account_id uuid,
  carrier_payable_account_id uuid,
  default_account_id uuid,
  default_preset_id uuid,
  default_rate_rule text NOT NULL DEFAULT 'cheapest',
  markup_bps integer NOT NULL DEFAULT 0,
  default_insurance text NOT NULL DEFAULT 'none',
  default_signature text NOT NULL DEFAULT 'none',
  customs_defaults jsonb NOT NULL DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT shipping_settings_pkey PRIMARY KEY (id),
  CONSTRAINT shipping_settings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT shipping_settings_org_singleton UNIQUE (org_id),
  CONSTRAINT shipping_settings_rate_rule_valid CHECK (default_rate_rule IN ('cheapest', 'fastest', 'cheapest_by_date')),
  CONSTRAINT shipping_settings_markup_nonnegative CHECK (markup_bps >= 0),
  CONSTRAINT shipping_settings_insurance_valid CHECK (default_insurance IN ('none', 'carrier_full')),
  CONSTRAINT shipping_settings_signature_valid CHECK (default_signature IN ('none', 'direct', 'adult')),
  FOREIGN KEY (org_id, shipping_expense_account_id) REFERENCES public.accounts(org_id, id) ON DELETE SET NULL,
  FOREIGN KEY (org_id, carrier_payable_account_id) REFERENCES public.accounts(org_id, id) ON DELETE SET NULL,
  FOREIGN KEY (org_id, default_account_id) REFERENCES public.shipping_accounts(org_id, id) ON DELETE SET NULL,
  FOREIGN KEY (org_id, default_preset_id) REFERENCES public.package_presets(org_id, id) ON DELETE SET NULL
);
ALTER TABLE public.shipping_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.shipping_settings
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.shipping_settings IS 'openbooks:org_isolation:v1';

CREATE TABLE public.shipment_labels (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  shipment_document_id uuid NOT NULL,
  order_document_id uuid,
  account_id uuid NOT NULL,
  provider text NOT NULL,
  provider_shipment_id text NOT NULL,
  provider_rate_id text NOT NULL,
  provider_label_id text,
  carrier text NOT NULL,
  service text NOT NULL,
  rate_minor bigint NOT NULL,
  rate_currency text NOT NULL,
  label_url text,
  label_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  tracking_number text,
  tracking_status text NOT NULL DEFAULT 'unknown',
  events jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'purchased',
  cost_entry_id uuid,
  purchased_at timestamp with time zone DEFAULT now() NOT NULL,
  voided_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT shipment_labels_pkey PRIMARY KEY (id),
  CONSTRAINT shipment_labels_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT shipment_labels_provider_valid CHECK (provider IN ('easypost', 'shippo')),
  CONSTRAINT shipment_labels_rate_nonnegative CHECK (rate_minor >= 0),
  CONSTRAINT shipment_labels_currency_nonblank CHECK (length(btrim(rate_currency)) = 3),
  CONSTRAINT shipment_labels_status_valid CHECK (status IN ('purchased', 'voided', 'refunded')),
  CONSTRAINT shipment_labels_tracking_status_valid CHECK (tracking_status IN (
    'unknown', 'pre_transit', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned', 'cancelled')),
  CONSTRAINT shipment_labels_voided_at_consistent CHECK (
    (status = 'purchased' AND voided_at IS NULL) OR (status <> 'purchased' AND voided_at IS NOT NULL)),
  FOREIGN KEY (org_id, shipment_document_id) REFERENCES public.fulfillment_documents(org_id, document_id),
  FOREIGN KEY (org_id, account_id) REFERENCES public.shipping_accounts(org_id, id)
);
-- One live label per shipment and provider rate: buying the same rate twice
-- converges on the existing row instead of charging the carrier twice.
CREATE UNIQUE INDEX shipment_labels_live_rate_unique
  ON public.shipment_labels (org_id, shipment_document_id, provider_rate_id)
  WHERE status = 'purchased';
CREATE INDEX shipment_labels_org_shipment ON public.shipment_labels (org_id, shipment_document_id);
CREATE INDEX shipment_labels_org_tracking ON public.shipment_labels (org_id, tracking_number) WHERE tracking_number IS NOT NULL;
ALTER TABLE public.shipment_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.shipment_labels
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.shipment_labels IS 'openbooks:org_isolation:v1';

CREATE TABLE public.shipping_rate_quotes (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  shipment_document_id uuid NOT NULL,
  account_id uuid NOT NULL,
  request_hash text NOT NULL,
  rates jsonb NOT NULL DEFAULT '[]',
  quoted_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT shipping_rate_quotes_pkey PRIMARY KEY (id),
  CONSTRAINT shipping_rate_quotes_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT shipping_rate_quotes_hash_nonblank CHECK (length(btrim(request_hash)) > 0),
  CONSTRAINT shipping_rate_quotes_expiry_valid CHECK (expires_at > quoted_at),
  FOREIGN KEY (org_id, shipment_document_id) REFERENCES public.fulfillment_documents(org_id, document_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, account_id) REFERENCES public.shipping_accounts(org_id, id) ON DELETE CASCADE
);
CREATE INDEX shipping_rate_quotes_org_lookup
  ON public.shipping_rate_quotes (org_id, shipment_document_id, request_hash);
ALTER TABLE public.shipping_rate_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_rate_quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.shipping_rate_quotes
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.shipping_rate_quotes IS 'openbooks:org_isolation:v1';

CREATE TABLE public.shipping_adjustments (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  label_id uuid NOT NULL,
  provider_adjustment_id text NOT NULL,
  kind text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  entry_id uuid,
  occurred_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT shipping_adjustments_pkey PRIMARY KEY (id),
  CONSTRAINT shipping_adjustments_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT shipping_adjustments_provider_identity UNIQUE (org_id, provider_adjustment_id),
  CONSTRAINT shipping_adjustments_identity_nonblank CHECK (length(btrim(provider_adjustment_id)) > 0),
  CONSTRAINT shipping_adjustments_kind_valid CHECK (kind IN (
    'weight_correction', 'dimension_correction', 'address_correction', 'fuel', 'duplicate', 'other')),
  CONSTRAINT shipping_adjustments_amount_nonzero CHECK (amount_minor <> 0),
  CONSTRAINT shipping_adjustments_currency_nonblank CHECK (length(btrim(currency)) = 3),
  CONSTRAINT shipping_adjustments_status_valid CHECK (status IN ('pending', 'posted', 'disputed')),
  FOREIGN KEY (org_id, label_id) REFERENCES public.shipment_labels(org_id, id) ON DELETE CASCADE
);
CREATE INDEX shipping_adjustments_org_label ON public.shipping_adjustments (org_id, label_id);
ALTER TABLE public.shipping_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipping_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.shipping_adjustments
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.shipping_adjustments IS 'openbooks:org_isolation:v1';

ALTER TABLE public.items ADD COLUMN weight numeric(19, 4);
ALTER TABLE public.items ADD COLUMN weight_unit text;
ALTER TABLE public.items ADD COLUMN dimensions jsonb;
ALTER TABLE public.items ADD COLUMN hs_code text;
ALTER TABLE public.items ADD COLUMN country_of_origin text;
ALTER TABLE public.items ADD CONSTRAINT items_weight_positive CHECK (weight IS NULL OR weight > 0);
ALTER TABLE public.items ADD CONSTRAINT items_weight_unit_valid CHECK (weight_unit IS NULL OR weight_unit IN ('g', 'kg', 'oz', 'lb'));
ALTER TABLE public.items ADD CONSTRAINT items_origin_country_valid
  CHECK (country_of_origin IS NULL OR length(btrim(country_of_origin)) = 2);

insert into public.openbooks_query_catalog_relations (relation, added_in)
 values ('shipping_accounts', '0504_shipping_hub'),
        ('package_presets', '0504_shipping_hub'),
        ('shipping_settings', '0504_shipping_hub'),
        ('shipment_labels', '0504_shipping_hub'),
        ('shipping_rate_quotes', '0504_shipping_hub'),
        ('shipping_adjustments', '0504_shipping_hub')
 on conflict (relation) do nothing; -- expected on replay
select public.openbooks_refresh_query_catalog();
