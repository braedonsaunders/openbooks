-- OpenBooks forward migration 0522_channel_orders.
-- Channel order subledger: normalized storefront orders awaiting posting,
-- their refund/cancellation/edit/fulfilment events, daily summary batches,
-- the effective-dated posting policy per channel, and the channel reference
-- carried on documents created from a channel order.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.channel_orders (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  external_id text NOT NULL,
  external_number text NOT NULL,
  customer_external_id text,
  customer_party_id uuid,
  customer_name text,
  customer_email text,
  customer_address jsonb,
  shop_currency text NOT NULL,
  presentment_currency text NOT NULL,
  presentment_rate numeric(19,10),
  subtotal_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  shipping_minor bigint NOT NULL,
  discount_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL,
  financial_status text NOT NULL DEFAULT '',
  fulfilment_status text NOT NULL DEFAULT '',
  order_tags text[] NOT NULL DEFAULT '{}',
  order_source text,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  shipping_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  tenders jsonb NOT NULL DEFAULT '[]'::jsonb,
  ordered_at timestamp with time zone NOT NULL,
  cancelled_at timestamp with time zone,
  posting_status text NOT NULL DEFAULT 'pending',
  posting_document_id uuid,
  summary_id uuid,
  exception_code text,
  exception_reason text,
  exception_remedy text,
  exclude_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT channel_orders_pkey PRIMARY KEY (id),
  CONSTRAINT channel_orders_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT channel_orders_external_id_nonblank CHECK (length(btrim(external_id)) > 0),
  CONSTRAINT channel_orders_external_number_nonblank CHECK (length(btrim(external_number)) > 0),
  CONSTRAINT channel_orders_currency_nonblank CHECK (length(btrim(shop_currency)) > 0 AND length(btrim(presentment_currency)) > 0),
  CONSTRAINT channel_orders_posting_status_valid
    CHECK (posting_status IN ('pending', 'posted', 'summarized', 'exception', 'excluded')),
  CONSTRAINT channel_orders_exception_present
    CHECK ((posting_status = 'exception') = (exception_code IS NOT NULL)),
  CONSTRAINT channel_orders_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_orders_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_orders_customer_tenant_fk
    FOREIGN KEY (org_id, customer_party_id) REFERENCES public.parties(org_id, id),
  CONSTRAINT channel_orders_document_tenant_fk
    FOREIGN KEY (org_id, posting_document_id) REFERENCES public.documents(org_id, id)
);

CREATE UNIQUE INDEX channel_orders_channel_external_unique
  ON public.channel_orders (org_id, channel_id, external_id);
CREATE INDEX channel_orders_posting_scan
  ON public.channel_orders (org_id, channel_id, posting_status);

ALTER TABLE public.channel_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_orders
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_orders IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_orders IS
  'Channel subledger: one row per storefront order with normalized lines, tenders and both currencies. Amounts are minor units in the shop currency; the row links to its posted document or daily summary, or parks with an exception code and remedy.';

CREATE TABLE public.channel_order_events (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  order_id uuid NOT NULL,
  kind text NOT NULL,
  external_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  posting_status text NOT NULL DEFAULT 'pending',
  posting_document_id uuid,
  exception_code text,
  exception_reason text,
  exception_remedy text,
  occurred_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT channel_order_events_pkey PRIMARY KEY (id),
  CONSTRAINT channel_order_events_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT channel_order_events_kind_valid
    CHECK (kind IN ('refund', 'cancellation', 'edit', 'fulfilment')),
  CONSTRAINT channel_order_events_external_id_nonblank CHECK (length(btrim(external_id)) > 0),
  CONSTRAINT channel_order_events_posting_status_valid
    CHECK (posting_status IN ('pending', 'posted', 'exception', 'ignored')),
  CONSTRAINT channel_order_events_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_order_events_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_order_events_order_tenant_fk
    FOREIGN KEY (org_id, order_id) REFERENCES public.channel_orders(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_order_events_document_tenant_fk
    FOREIGN KEY (org_id, posting_document_id) REFERENCES public.documents(org_id, id)
);

CREATE UNIQUE INDEX channel_order_events_order_external_unique
  ON public.channel_order_events (org_id, order_id, external_id);

ALTER TABLE public.channel_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_order_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_order_events
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_order_events IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_order_events IS
  'Refunds, cancellations, edits and fulfilments per channel order, each with its own posting status and document.';

CREATE TABLE public.channel_daily_summaries (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  summary_date date NOT NULL,
  stock_location_id uuid NOT NULL,
  currency text NOT NULL,
  order_count integer NOT NULL DEFAULT 0,
  subtotal_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  shipping_minor bigint NOT NULL DEFAULT 0,
  discount_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  posting_document_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT channel_daily_summaries_pkey PRIMARY KEY (id),
  CONSTRAINT channel_daily_summaries_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT channel_daily_summaries_currency_nonblank CHECK (length(btrim(currency)) > 0),
  CONSTRAINT channel_daily_summaries_status_valid CHECK (status IN ('open', 'posted')),
  CONSTRAINT channel_daily_summaries_counts_valid CHECK (order_count >= 0),
  CONSTRAINT channel_daily_summaries_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_daily_summaries_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_daily_summaries_location_tenant_fk
    FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations(org_id, id),
  CONSTRAINT channel_daily_summaries_document_tenant_fk
    FOREIGN KEY (org_id, posting_document_id) REFERENCES public.documents(org_id, id)
);

CREATE UNIQUE INDEX channel_daily_summaries_batch_unique
  ON public.channel_daily_summaries (org_id, channel_id, summary_date, stock_location_id, currency);

ALTER TABLE public.channel_daily_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_daily_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_daily_summaries
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_daily_summaries IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_daily_summaries IS
  'Daily summary posting batches per channel, day, stock location and currency. One cash sale per batch; the per-order detail stays drillable on channel_orders.';

ALTER TABLE public.channel_orders
  ADD CONSTRAINT channel_orders_summary_tenant_fk
    FOREIGN KEY (org_id, summary_id) REFERENCES public.channel_daily_summaries(org_id, id);

-- Effective-dated posting policy per channel: the posting mode and the
-- order-to-document rules in force from a date. Changing the mode never
-- reinterprets posted history: orders posted under an earlier policy keep
-- their documents, and the switch shows its effective date before commit.
CREATE TABLE public.sales_channel_posting_policies (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  mode text NOT NULL,
  unpaid_creates_sales_order boolean NOT NULL DEFAULT false,
  guest_customer_party_id uuid,
  create_promotion_on_match_miss boolean NOT NULL DEFAULT false,
  cutoff_tz text NOT NULL DEFAULT 'UTC',
  excluded_tags text[] NOT NULL DEFAULT '{}',
  excluded_sources text[] NOT NULL DEFAULT '{}',
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT sales_channel_posting_policies_pkey PRIMARY KEY (id),
  CONSTRAINT sales_channel_posting_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT sales_channel_posting_policies_mode_valid
    CHECK (mode IN ('per_order', 'daily_summary')),
  CONSTRAINT sales_channel_posting_policies_tz_nonblank CHECK (length(btrim(cutoff_tz)) > 0),
  CONSTRAINT sales_channel_posting_policies_window_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT sales_channel_posting_policies_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT sales_channel_posting_policies_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT sales_channel_posting_policies_guest_tenant_fk
    FOREIGN KEY (org_id, guest_customer_party_id) REFERENCES public.parties(org_id, id),
  CONSTRAINT sales_channel_posting_policies_no_overlap
    EXCLUDE USING gist (
      org_id WITH =,
      channel_id WITH =,
      (daterange(effective_from, effective_to, '[]')) WITH &&
    )
);

CREATE INDEX sales_channel_posting_policies_lookup
  ON public.sales_channel_posting_policies (org_id, channel_id, effective_from);

ALTER TABLE public.sales_channel_posting_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_channel_posting_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.sales_channel_posting_policies
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.sales_channel_posting_policies IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.sales_channel_posting_policies IS
  'Effective-dated posting policy per channel: exactly one open row per channel for any date, so a mode switch never reinterprets posted history.';

-- The channel order reference shown on every document created from a channel.
ALTER TABLE public.documents ADD COLUMN source_channel_id uuid;
ALTER TABLE public.documents
  ADD CONSTRAINT documents_source_channel_tenant_fk
    FOREIGN KEY (org_id, source_channel_id) REFERENCES public.sales_channels(org_id, id);
CREATE INDEX documents_source_channel
  ON public.documents (org_id, source_channel_id)
  WHERE source_channel_id IS NOT NULL;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_orders', '0522_channel_orders')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_order_events', '0522_channel_orders')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_daily_summaries', '0522_channel_orders')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('sales_channel_posting_policies', '0522_channel_orders')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
