-- OpenBooks forward migration 0533_order_economics.
-- Contribution margin per channel order line from stored, additive facts.
-- channel_order_economics keeps one current fact per (order, line, cost
-- component, source); a late cost (label purchase, payout settlement, refund)
-- restates the order by inserting a new version and retiring the old row, so
-- history is kept and no ratio is ever stored. channel_ad_spend holds the
-- imported daily marketing spend per channel that CM3 allocates.
-- channel_order_economics_pending is the cross-module dirty queue: label
-- purchase and payout settlement run in modules that cannot import commerce,
-- so they mark affected orders here and the channel sync scan recomputes.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.channel_order_economics (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_key text NOT NULL,
  component text NOT NULL,
  source_kind text NOT NULL,
  source_ref text NOT NULL DEFAULT '',
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  item_id uuid,
  sku text,
  promotion_code text,
  estimated boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  superseded_by uuid,
  as_of timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT channel_order_economics_pkey PRIMARY KEY (id),
  CONSTRAINT channel_order_economics_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT channel_order_economics_line_key_nonblank CHECK (length(btrim(line_key)) > 0),
  CONSTRAINT channel_order_economics_currency_nonblank CHECK (length(btrim(currency)) > 0),
  CONSTRAINT channel_order_economics_component_valid
    CHECK (component IN ('net_revenue', 'discount', 'cogs', 'processor_fee', 'shipping_label',
      'marketplace_fee', 'stored_value_funding', 'returns', 'restocking_fee', 'ad_spend')),
  CONSTRAINT channel_order_economics_source_valid
    CHECK (source_kind IN ('posting', 'fulfilment', 'label', 'payout', 'refund', 'estimate', 'import', 'manual')),
  CONSTRAINT channel_order_economics_version_valid CHECK (version >= 1),
  CONSTRAINT channel_order_economics_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_order_economics_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_order_economics_order_tenant_fk
    FOREIGN KEY (org_id, order_id) REFERENCES public.channel_orders(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_order_economics_item_tenant_fk
    FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id)
);

CREATE UNIQUE INDEX channel_order_economics_current_unique
  ON public.channel_order_economics (org_id, order_id, line_key, component, source_kind, source_ref)
  WHERE is_current;
CREATE INDEX channel_order_economics_order_current
  ON public.channel_order_economics (org_id, order_id)
  WHERE is_current;
CREATE INDEX channel_order_economics_channel_day
  ON public.channel_order_economics (org_id, channel_id, as_of)
  WHERE is_current;

ALTER TABLE public.channel_order_economics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_order_economics FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_order_economics
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_order_economics IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_order_economics IS
  'Stored additive margin facts per channel order line: one current row per (order, line, component, source). Amounts are signed margin contributions in minor units of the row currency (revenue and restocking fees positive; discounts, costs, fees and returns negative). Late costs restate by inserting a new version, never by overwriting; ratios are computed in the report engine, never stored here.';

CREATE TABLE public.channel_ad_spend (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  spend_date date NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  source text NOT NULL DEFAULT '',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT channel_ad_spend_pkey PRIMARY KEY (id),
  CONSTRAINT channel_ad_spend_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT channel_ad_spend_amount_valid CHECK (amount_minor >= 0),
  CONSTRAINT channel_ad_spend_currency_nonblank CHECK (length(btrim(currency)) > 0),
  CONSTRAINT channel_ad_spend_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_ad_spend_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX channel_ad_spend_day_unique
  ON public.channel_ad_spend (org_id, channel_id, spend_date, source);
CREATE INDEX channel_ad_spend_channel_day
  ON public.channel_ad_spend (org_id, channel_id, spend_date);

ALTER TABLE public.channel_ad_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_ad_spend FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_ad_spend
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_ad_spend IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_ad_spend IS
  'Imported daily marketing spend per channel in minor units. CM3 allocates each day''s spend across that day''s channel orders by revenue; the (channel, day, source) key keeps re-imports idempotent.';

CREATE TABLE public.channel_order_economics_pending (
  org_id uuid NOT NULL,
  order_id uuid NOT NULL,
  reason text NOT NULL,
  enqueued_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT channel_order_economics_pending_reason_nonblank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT channel_order_economics_pending_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_order_economics_pending_order_tenant_fk
    FOREIGN KEY (org_id, order_id) REFERENCES public.channel_orders(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX channel_order_economics_pending_unique
  ON public.channel_order_economics_pending (org_id, order_id);

ALTER TABLE public.channel_order_economics_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_order_economics_pending FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_order_economics_pending
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_order_economics_pending IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_order_economics_pending IS
  'Dirty queue for order margin restatement. Label purchase and payout settlement run in modules that cannot import commerce, so they mark affected orders here with the reason; the channel sync scan recomputes and clears the mark.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_order_economics', '0533_order_economics')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_ad_spend', '0533_order_economics')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_order_economics_pending', '0533_order_economics')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
