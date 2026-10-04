-- OpenBooks forward migration 0496_promotions_restocking.
-- Promotions master with per-org case-insensitive codes, the promotion link
-- on sales document lines, and effective-dated restocking fee policies.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.promotions (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  percent_value numeric(9,4),
  amount_minor bigint,
  currency char(3),
  buy_quantity integer,
  get_quantity integer,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  -- Channel scope. No foreign key: the sales channel registry lands
  -- separately and adds the reference; matching compares this id.
  channel_scope_id uuid,
  usage_limit integer,
  usage_count integer NOT NULL DEFAULT 0,
  discount_account_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT promotions_pkey PRIMARY KEY (id),
  CONSTRAINT promotions_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT promotions_kind_valid CHECK (kind in ('percent', 'amount', 'free_shipping', 'buy_x_get_y')),
  CONSTRAINT promotions_status_valid CHECK (status in ('draft', 'active', 'archived')),
  CONSTRAINT promotions_window_valid CHECK (starts_at is null or ends_at is null or ends_at > starts_at),
  CONSTRAINT promotions_percent_value_valid CHECK (
    (kind = 'percent' and percent_value is not null and percent_value > 0 and percent_value <= 100
     and amount_minor is null and buy_quantity is null and get_quantity is null)
    or (kind <> 'percent' and percent_value is null)),
  CONSTRAINT promotions_amount_value_valid CHECK (
    (kind = 'amount' and amount_minor is not null and amount_minor > 0 and currency is not null
     and buy_quantity is null and get_quantity is null)
    or (kind <> 'amount' and amount_minor is null and (kind = 'free_shipping' or currency is null))),
  CONSTRAINT promotions_bogo_valid CHECK (
    (kind = 'buy_x_get_y' and buy_quantity is not null and buy_quantity > 0
     and get_quantity is not null and get_quantity > 0 and currency is null)
    or (kind <> 'buy_x_get_y' and buy_quantity is null and get_quantity is null)),
  CONSTRAINT promotions_free_shipping_bare CHECK (
    kind <> 'free_shipping' or (currency is null)),
  CONSTRAINT promotions_usage_limit_valid CHECK (usage_limit is null or usage_limit > 0),
  CONSTRAINT promotions_usage_count_valid CHECK (usage_count >= 0),
  CONSTRAINT promotions_currency_valid CHECK (currency is null or currency ~ '^[A-Z]{3}$'),
  FOREIGN KEY (org_id, discount_account_id) REFERENCES public.accounts(org_id, id)
);
-- One code per organization, matched case-insensitively: SAVE10 and save10
-- are the same promotion. A UNIQUE constraint cannot carry the lower()
-- expression, so this takes a unique index.
CREATE UNIQUE INDEX promotions_org_code_ci ON public.promotions (org_id, lower(code));
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.promotions
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.promotions IS 'openbooks:org_isolation:v1';

CREATE TABLE public.restocking_fee_policies (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  -- Scope: exactly one of item, item category, or neither (the default
  -- policy). Overlapping open policies per scope are refused by the setup
  -- write hook under an advisory lock; see the engine resolver.
  item_category text,
  item_id uuid,
  kind text NOT NULL,
  fee_percent numeric(9,4),
  fee_amount_minor bigint,
  -- Fixed-fee currency. Null means the fee is denominated in the credited
  -- document's currency; a set currency only matches that currency.
  currency char(3),
  income_account_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  waivable boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT restocking_fee_policies_pkey PRIMARY KEY (id),
  CONSTRAINT restocking_fee_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT restocking_fee_policies_kind_valid CHECK (kind in ('percent', 'fixed')),
  CONSTRAINT restocking_fee_policies_scope_valid CHECK (num_nonnulls(item_category, item_id) <= 1),
  CONSTRAINT restocking_fee_policies_percent_valid CHECK (
    (kind = 'percent' and fee_percent is not null and fee_percent > 0 and fee_percent <= 100
     and fee_amount_minor is null)
    or (kind <> 'percent' and fee_percent is null)),
  CONSTRAINT restocking_fee_policies_fixed_valid CHECK (
    (kind = 'fixed' and fee_amount_minor is not null and fee_amount_minor > 0)
    or (kind <> 'fixed' and fee_amount_minor is null)),
  CONSTRAINT restocking_fee_policies_window_valid CHECK (effective_to is null or effective_to >= effective_from),
  CONSTRAINT restocking_fee_policies_currency_valid CHECK (currency is null or currency ~ '^[A-Z]{3}$'),
  FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id),
  FOREIGN KEY (org_id, income_account_id) REFERENCES public.accounts(org_id, id)
);
ALTER TABLE public.restocking_fee_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restocking_fee_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.restocking_fee_policies
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.restocking_fee_policies IS 'openbooks:org_isolation:v1';

ALTER TABLE public.document_lines ADD COLUMN promotion_id uuid;
ALTER TABLE public.document_lines
  ADD CONSTRAINT document_lines_promotion_id_fkey
  FOREIGN KEY (org_id, promotion_id) REFERENCES public.promotions(org_id, id);
CREATE INDEX document_lines_promotion_id ON public.document_lines (org_id, promotion_id)
  WHERE promotion_id IS NOT NULL;

INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES ('promotions','0496'),('restocking_fee_policies','0496') on conflict (relation) do nothing; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
