-- OpenBooks forward migration 0686_intercompany_paired_transactions_cross_subsidiary_fulfillment.
--
-- Paired intercompany transactions: an explicit, audited link between the
-- selling entity's sales order, invoice or credit memo and the buying
-- entity's purchase order, vendor bill or vendor credit. A document belongs
-- to at most one live pair; unlinking keeps the row with its reason so the
-- pairing history is never lost. The guard requires both documents to be of
-- the pair's kinds and to belong to the pair's two subsidiaries.
--
-- Transfer pricing policies are effective-dated intercompany prices for a
-- selling entity (optionally for one buying entity): a price level or a
-- cost-plus markup, with the eliminated revenue and cost accounts the
-- cross-charge posts to. Active windows for the same entities never overlap,
-- and a policy that has priced a charge keeps its terms; only its end date may
-- change, never before its last charge.
--
-- Cross-subsidiary fulfillment charges record each shipment line one entity
-- fulfilled from another entity's stock: the fulfilling entity's inventory
-- movement at cost, the transfer price and the intercompany cross-charge
-- entry. Returns record the symmetric reversal against the original charge.
-- Charges are append-only.
--
-- Backfill: none. All three tables start empty.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Paired transactions ---------------------------------------------------------

CREATE TABLE public.intercompany_transaction_pairs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  pair_kind text NOT NULL,
  seller_subsidiary_id uuid NOT NULL,
  buyer_subsidiary_id uuid NOT NULL,
  seller_document_id uuid NOT NULL,
  buyer_document_id uuid NOT NULL,
  origin text NOT NULL,
  status text DEFAULT 'linked' NOT NULL,
  link_reason text,
  linked_by uuid NOT NULL,
  linked_at timestamp with time zone DEFAULT now() NOT NULL,
  unlinked_by uuid,
  unlinked_at timestamp with time zone,
  unlink_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT intercompany_transaction_pairs_pkey PRIMARY KEY (id),
  CONSTRAINT intercompany_transaction_pairs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT intercompany_transaction_pairs_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT intercompany_transaction_pairs_seller_subsidiary_fk
    FOREIGN KEY (org_id, seller_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transaction_pairs_buyer_subsidiary_fk
    FOREIGN KEY (org_id, buyer_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transaction_pairs_seller_document_fk
    FOREIGN KEY (org_id, seller_document_id) REFERENCES public.documents(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transaction_pairs_buyer_document_fk
    FOREIGN KEY (org_id, buyer_document_id) REFERENCES public.documents(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transaction_pairs_linked_by_fk
    FOREIGN KEY (org_id, linked_by) REFERENCES public.users(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transaction_pairs_kind CHECK (pair_kind IN ('order', 'invoice', 'credit')),
  CONSTRAINT intercompany_transaction_pairs_origin CHECK (origin IN ('generated', 'linked')),
  CONSTRAINT intercompany_transaction_pairs_status CHECK (status IN ('linked', 'unlinked')),
  CONSTRAINT intercompany_transaction_pairs_entities CHECK (seller_subsidiary_id <> buyer_subsidiary_id),
  CONSTRAINT intercompany_transaction_pairs_documents CHECK (seller_document_id <> buyer_document_id),
  CONSTRAINT intercompany_transaction_pairs_link_reason
    CHECK (link_reason IS NULL OR length(btrim(link_reason)) BETWEEN 1 AND 2000),
  CONSTRAINT intercompany_transaction_pairs_unlink_evidence
    CHECK ((status = 'unlinked') = (unlinked_by IS NOT NULL AND unlinked_at IS NOT NULL
      AND length(btrim(coalesce(unlink_reason, ''))) BETWEEN 1 AND 2000))
);

CREATE UNIQUE INDEX intercompany_transaction_pairs_live_seller
  ON public.intercompany_transaction_pairs (org_id, seller_document_id) WHERE status = 'linked';
CREATE UNIQUE INDEX intercompany_transaction_pairs_live_buyer
  ON public.intercompany_transaction_pairs (org_id, buyer_document_id) WHERE status = 'linked';
CREATE INDEX intercompany_transaction_pairs_entities
  ON public.intercompany_transaction_pairs (org_id, seller_subsidiary_id, buyer_subsidiary_id, status);

CREATE OR REPLACE FUNCTION public.intercompany_transaction_pair_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  v_root uuid;
  v_seller record;
  v_buyer record;
  v_seller_kind text;
  v_buyer_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
       OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'intercompany pairing history is retained; unlink the pair instead';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT (OLD.status = 'linked' AND NEW.status = 'unlinked')
       OR to_jsonb(NEW) - 'status' - 'unlinked_by' - 'unlinked_at' - 'unlink_reason' - 'updated_at'
          IS DISTINCT FROM
          to_jsonb(OLD) - 'status' - 'unlinked_by' - 'unlinked_at' - 'unlink_reason' - 'updated_at' THEN
      RAISE EXCEPTION 'an intercompany pair changes only by unlinking it';
    END IF;
    RETURN NEW;
  END IF;
  IF public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  v_seller_kind := CASE NEW.pair_kind WHEN 'order' THEN 'sales_order' WHEN 'invoice' THEN 'customer_invoice' ELSE 'customer_credit' END;
  v_buyer_kind := CASE NEW.pair_kind WHEN 'order' THEN 'purchase_order' WHEN 'invoice' THEN 'vendor_bill' ELSE 'vendor_credit' END;
  SELECT s.id INTO v_root FROM public.subsidiaries s WHERE s.org_id = NEW.org_id AND s.parent_id IS NULL;
  SELECT d.kind, coalesce(d.subsidiary_id, v_root) AS subsidiary_id, d.status INTO v_seller
    FROM public.documents d WHERE d.org_id = NEW.org_id AND d.id = NEW.seller_document_id;
  SELECT d.kind, coalesce(d.subsidiary_id, v_root) AS subsidiary_id, d.status INTO v_buyer
    FROM public.documents d WHERE d.org_id = NEW.org_id AND d.id = NEW.buyer_document_id;
  IF v_seller.kind IS DISTINCT FROM v_seller_kind OR v_buyer.kind IS DISTINCT FROM v_buyer_kind THEN
    RAISE EXCEPTION 'an intercompany % pair links a % to a %', NEW.pair_kind, v_seller_kind, v_buyer_kind
      USING errcode = '23514';
  END IF;
  IF v_seller.subsidiary_id IS DISTINCT FROM NEW.seller_subsidiary_id
     OR v_buyer.subsidiary_id IS DISTINCT FROM NEW.buyer_subsidiary_id THEN
    RAISE EXCEPTION 'intercompany pair documents must belong to the pair''s selling and buying subsidiaries'
      USING errcode = '23514';
  END IF;
  IF v_seller.status = 'voided' OR v_buyer.status = 'voided' THEN
    RAISE EXCEPTION 'a voided document cannot be paired' USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER intercompany_transaction_pair_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.intercompany_transaction_pairs
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_transaction_pair_guard();

ALTER TABLE public.intercompany_transaction_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercompany_transaction_pairs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.intercompany_transaction_pairs
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.intercompany_transaction_pairs IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.intercompany_transaction_pairs IS
  'Explicit links between a selling entity''s intercompany sales document and the buying entity''s purchase document; unlinked rows keep the pairing history.';

-- Transfer pricing policies ---------------------------------------------------

CREATE TABLE public.intercompany_transfer_pricing_policies (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  seller_subsidiary_id uuid NOT NULL,
  buyer_subsidiary_id uuid,
  method text NOT NULL,
  price_level_id uuid,
  markup_percent numeric(9,4),
  revenue_account_id uuid NOT NULL,
  cost_account_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  description text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT intercompany_transfer_pricing_policies_pkey PRIMARY KEY (id),
  CONSTRAINT intercompany_transfer_pricing_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT intercompany_transfer_pricing_policies_code_unique UNIQUE (org_id, code),
  CONSTRAINT intercompany_transfer_pricing_policies_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT intercompany_transfer_pricing_policies_seller_fk
    FOREIGN KEY (org_id, seller_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transfer_pricing_policies_buyer_fk
    FOREIGN KEY (org_id, buyer_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transfer_pricing_policies_price_level_fk
    FOREIGN KEY (org_id, price_level_id) REFERENCES public.price_levels(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transfer_pricing_policies_revenue_fk
    FOREIGN KEY (org_id, revenue_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transfer_pricing_policies_cost_fk
    FOREIGN KEY (org_id, cost_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_transfer_pricing_policies_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT intercompany_transfer_pricing_policies_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT intercompany_transfer_pricing_policies_code CHECK (length(btrim(code)) BETWEEN 1 AND 64),
  CONSTRAINT intercompany_transfer_pricing_policies_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT intercompany_transfer_pricing_policies_entities
    CHECK (buyer_subsidiary_id IS NULL OR buyer_subsidiary_id <> seller_subsidiary_id),
  CONSTRAINT intercompany_transfer_pricing_policies_method CHECK (
    (method = 'price_level' AND price_level_id IS NOT NULL AND markup_percent IS NULL)
    OR (method = 'cost_plus' AND price_level_id IS NULL AND markup_percent IS NOT NULL
        AND markup_percent >= 0 AND markup_percent <= 1000)
  ),
  CONSTRAINT intercompany_transfer_pricing_policies_accounts CHECK (revenue_account_id <> cost_account_id),
  CONSTRAINT intercompany_transfer_pricing_policies_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT intercompany_transfer_pricing_policies_overlap EXCLUDE USING gist (
    org_id WITH =,
    seller_subsidiary_id WITH =,
    (coalesce(buyer_subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (is_active)
);

CREATE INDEX intercompany_transfer_pricing_policies_lookup
  ON public.intercompany_transfer_pricing_policies (org_id, seller_subsidiary_id, effective_from);

-- Cross-subsidiary fulfillment charges ------------------------------------------

CREATE TABLE public.intercompany_fulfillment_charges (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  kind text NOT NULL,
  fulfillment_document_id uuid NOT NULL,
  fulfillment_line_id uuid NOT NULL,
  credit_document_id uuid,
  reverses_charge_id uuid,
  selling_subsidiary_id uuid NOT NULL,
  fulfilling_subsidiary_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  item_id uuid NOT NULL,
  stock_location_id uuid NOT NULL,
  movement_id uuid NOT NULL,
  quantity numeric(28,8) NOT NULL,
  cost_amount numeric(19,4) NOT NULL,
  cost_currency text NOT NULL,
  transfer_currency text NOT NULL,
  transfer_unit_price numeric(28,8) NOT NULL,
  transfer_amount numeric(19,4) NOT NULL,
  entry_id uuid NOT NULL,
  charge_date date NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  CONSTRAINT intercompany_fulfillment_charges_pkey PRIMARY KEY (id),
  CONSTRAINT intercompany_fulfillment_charges_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT intercompany_fulfillment_charges_movement_unique UNIQUE (org_id, movement_id),
  CONSTRAINT intercompany_fulfillment_charges_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_fulfillment_fk
    FOREIGN KEY (org_id, fulfillment_document_id) REFERENCES public.documents(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_fulfillment_line_fk
    FOREIGN KEY (org_id, fulfillment_line_id) REFERENCES public.document_lines(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_credit_fk
    FOREIGN KEY (org_id, credit_document_id) REFERENCES public.documents(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_reverses_fk
    FOREIGN KEY (org_id, reverses_charge_id) REFERENCES public.intercompany_fulfillment_charges(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_selling_fk
    FOREIGN KEY (org_id, selling_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_fulfilling_fk
    FOREIGN KEY (org_id, fulfilling_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_policy_fk
    FOREIGN KEY (org_id, policy_id) REFERENCES public.intercompany_transfer_pricing_policies(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_item_fk
    FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_stock_location_fk
    FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_movement_fk
    FOREIGN KEY (movement_id) REFERENCES public.inventory_movements(id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_entry_fk
    FOREIGN KEY (org_id, entry_id) REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT intercompany_fulfillment_charges_kind CHECK (kind IN ('fulfillment', 'return')),
  CONSTRAINT intercompany_fulfillment_charges_return_source
    CHECK ((kind = 'return') = (reverses_charge_id IS NOT NULL AND credit_document_id IS NOT NULL)),
  CONSTRAINT intercompany_fulfillment_charges_entities CHECK (selling_subsidiary_id <> fulfilling_subsidiary_id),
  CONSTRAINT intercompany_fulfillment_charges_quantity CHECK (quantity > 0),
  CONSTRAINT intercompany_fulfillment_charges_amounts
    CHECK (cost_amount >= 0 AND transfer_amount >= 0 AND transfer_unit_price >= 0),
  CONSTRAINT intercompany_fulfillment_charges_currencies
    CHECK (cost_currency ~ '^[A-Z]{3}$' AND transfer_currency ~ '^[A-Z]{3}$')
);

CREATE INDEX intercompany_fulfillment_charges_fulfillment
  ON public.intercompany_fulfillment_charges (org_id, fulfillment_document_id);
CREATE INDEX intercompany_fulfillment_charges_reverses
  ON public.intercompany_fulfillment_charges (org_id, reverses_charge_id) WHERE reverses_charge_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.intercompany_fulfillment_charge_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
     OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'cross-subsidiary fulfillment charges are append-only; a return records the reversal';
END;
$$;

CREATE TRIGGER intercompany_fulfillment_charge_immutable
  BEFORE UPDATE OR DELETE ON public.intercompany_fulfillment_charges
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_fulfillment_charge_immutable();

-- A policy that has priced a charge keeps its terms. Its window may still be
-- closed, but never before the last charge it priced.
CREATE OR REPLACE FUNCTION public.intercompany_transfer_pricing_policy_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  v_last date;
  v_account record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
       OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM public.intercompany_fulfillment_charges c WHERE c.org_id = OLD.org_id AND c.policy_id = OLD.id) THEN
      RAISE EXCEPTION 'this transfer pricing policy has priced charges; end its window instead of deleting it';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT max(c.charge_date) INTO v_last FROM public.intercompany_fulfillment_charges c
     WHERE c.org_id = OLD.org_id AND c.policy_id = OLD.id;
    IF v_last IS NOT NULL THEN
      IF (NEW.code, NEW.seller_subsidiary_id, NEW.buyer_subsidiary_id, NEW.method, NEW.price_level_id,
          NEW.markup_percent, NEW.revenue_account_id, NEW.cost_account_id, NEW.effective_from)
         IS DISTINCT FROM
         (OLD.code, OLD.seller_subsidiary_id, OLD.buyer_subsidiary_id, OLD.method, OLD.price_level_id,
          OLD.markup_percent, OLD.revenue_account_id, OLD.cost_account_id, OLD.effective_from) THEN
        RAISE EXCEPTION 'this transfer pricing policy has priced charges and keeps its terms; end it and create a new dated policy';
      END IF;
      IF NEW.effective_to IS NOT NULL AND NEW.effective_to < v_last THEN
        RAISE EXCEPTION 'this transfer pricing policy priced a charge on %; its window cannot end before that date', v_last;
      END IF;
    END IF;
    -- Ending or deactivating a policy never re-validates terms it already holds.
    IF (NEW.seller_subsidiary_id, NEW.buyer_subsidiary_id, NEW.revenue_account_id, NEW.cost_account_id)
       IS NOT DISTINCT FROM
       (OLD.seller_subsidiary_id, OLD.buyer_subsidiary_id, OLD.revenue_account_id, OLD.cost_account_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.subsidiaries s
     WHERE s.org_id = NEW.org_id AND s.id = NEW.seller_subsidiary_id AND s.is_active AND NOT s.is_elimination
  ) OR (NEW.buyer_subsidiary_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.subsidiaries s
     WHERE s.org_id = NEW.org_id AND s.id = NEW.buyer_subsidiary_id AND s.is_active AND NOT s.is_elimination
  )) THEN
    RAISE EXCEPTION 'transfer pricing applies between active operating subsidiaries' USING errcode = '23514';
  END IF;
  FOR v_account IN
    SELECT account_id, types, label FROM (VALUES
      (NEW.revenue_account_id, ARRAY['income', 'income_other'], 'intercompany revenue'),
      (NEW.cost_account_id, ARRAY['cogs', 'expense', 'expense_other'], 'intercompany cost')
    ) AS a(account_id, types, label)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.accounts a
       WHERE a.org_id = NEW.org_id AND a.id = v_account.account_id
         AND a.is_active AND NOT a.is_summary AND a.eliminate AND a.type = ANY (v_account.types)
    ) THEN
      RAISE EXCEPTION 'the % account must be an active eliminated posting account of type %', v_account.label, array_to_string(v_account.types, ', ')
        USING errcode = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER intercompany_transfer_pricing_policy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.intercompany_transfer_pricing_policies
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_transfer_pricing_policy_guard();

ALTER TABLE public.intercompany_transfer_pricing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercompany_transfer_pricing_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.intercompany_transfer_pricing_policies
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.intercompany_transfer_pricing_policies IS 'openbooks:org_isolation:v1';

ALTER TABLE public.intercompany_fulfillment_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercompany_fulfillment_charges FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.intercompany_fulfillment_charges
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.intercompany_fulfillment_charges IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.intercompany_transfer_pricing_policies IS
  'Effective-dated intercompany transfer prices: a price level or a cost-plus markup, with the eliminated accounts the cross-charge posts to.';
COMMENT ON TABLE public.intercompany_fulfillment_charges IS
  'Append-only record of each line fulfilled from another entity''s stock: the fulfilling entity''s movement at cost, the transfer price and the cross-charge entry.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
  ('intercompany_transaction_pairs', '0686_intercompany_paired_transactions_cross_subsidiary_fulfillment'),
  ('intercompany_transfer_pricing_policies', '0686_intercompany_paired_transactions_cross_subsidiary_fulfillment'),
  ('intercompany_fulfillment_charges', '0686_intercompany_paired_transactions_cross_subsidiary_fulfillment')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
