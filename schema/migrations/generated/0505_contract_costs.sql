-- Capitalized contract costs (ASC 340-40 / IFRS 15 costs to obtain a contract).
-- Policy is effective-dated; assets amortize over the contract term or the
-- expected customer life; amortization rows are immutable posted history.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.contract_cost_policies (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  effective_from date NOT NULL,
  capitalize_commissions boolean NOT NULL DEFAULT true,
  capitalize_fulfilment boolean NOT NULL DEFAULT false,
  practical_expedient boolean NOT NULL DEFAULT true,
  basis text NOT NULL DEFAULT 'contract_term',
  customer_life_source text NOT NULL DEFAULT 'manual',
  customer_life_months integer,
  renewal_commensurate_threshold_percent numeric(19,4) NOT NULL DEFAULT '50.0000',
  asset_account_id uuid,
  amortization_expense_account_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT contract_cost_policies_pkey PRIMARY KEY (id),
  CONSTRAINT contract_cost_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT contract_cost_policies_effective_unique UNIQUE (org_id, effective_from),
  CONSTRAINT contract_cost_policies_basis_valid
    CHECK (basis IN ('contract_term', 'customer_life')),
  CONSTRAINT contract_cost_policies_life_source_valid
    CHECK (customer_life_source IN ('manual', 'derived')),
  CONSTRAINT contract_cost_policies_life_months_positive
    CHECK (customer_life_months IS NULL OR customer_life_months > 0),
  CONSTRAINT contract_cost_policies_threshold_range
    CHECK (renewal_commensurate_threshold_percent > 0 AND renewal_commensurate_threshold_percent <= 100),
  CONSTRAINT contract_cost_policies_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT contract_cost_policies_asset_account_fk
    FOREIGN KEY (org_id, asset_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT contract_cost_policies_amort_account_fk
    FOREIGN KEY (org_id, amortization_expense_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE
);

CREATE TABLE public.contract_cost_assets (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  revenue_contract_id uuid,
  rep_party_id uuid,
  customer_party_id uuid,
  cost_type text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  capitalized_on date NOT NULL,
  amort_start_on date NOT NULL,
  amort_end_on date NOT NULL,
  method text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  capitalize_entry_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT contract_cost_assets_pkey PRIMARY KEY (id),
  CONSTRAINT contract_cost_assets_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT contract_cost_assets_type_valid
    CHECK (cost_type IN ('commission', 'fulfilment')),
  CONSTRAINT contract_cost_assets_method_valid
    CHECK (method IN ('straight_line', 'pattern')),
  CONSTRAINT contract_cost_assets_status_valid
    CHECK (status IN ('active', 'fully_amortized', 'impaired', 'expensed')),
  CONSTRAINT contract_cost_assets_amount_positive
    CHECK (amount_minor > 0),
  CONSTRAINT contract_cost_assets_currency_valid
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT contract_cost_assets_term_ordered
    CHECK (amort_start_on <= amort_end_on),
  CONSTRAINT contract_cost_assets_source_object
    CHECK (jsonb_typeof(source) = 'object'),
  CONSTRAINT contract_cost_assets_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT contract_cost_assets_contract_fk
    FOREIGN KEY (org_id, revenue_contract_id) REFERENCES public.revenue_contracts(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT contract_cost_assets_rep_fk
    FOREIGN KEY (rep_party_id) REFERENCES public.parties(id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT contract_cost_assets_customer_fk
    FOREIGN KEY (customer_party_id) REFERENCES public.parties(id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT contract_cost_assets_capitalize_entry_fk
    FOREIGN KEY (org_id, capitalize_entry_id) REFERENCES public.journal_entries(org_id, id) DEFERRABLE
);

CREATE INDEX contract_cost_assets_contract
  ON public.contract_cost_assets (org_id, revenue_contract_id);
CREATE INDEX contract_cost_assets_status
  ON public.contract_cost_assets (org_id, status);

CREATE TABLE public.contract_cost_amortization (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  period_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  journal_entry_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT contract_cost_amortization_pkey PRIMARY KEY (id),
  CONSTRAINT contract_cost_amortization_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT contract_cost_amortization_one_per_period UNIQUE (org_id, asset_id, period_id),
  CONSTRAINT contract_cost_amortization_entry_unique UNIQUE (org_id, journal_entry_id),
  CONSTRAINT contract_cost_amortization_amount_positive
    CHECK (amount_minor > 0),
  CONSTRAINT contract_cost_amortization_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT contract_cost_amortization_asset_fk
    FOREIGN KEY (org_id, asset_id) REFERENCES public.contract_cost_assets(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT contract_cost_amortization_period_fk
    FOREIGN KEY (org_id, period_id) REFERENCES public.accounting_periods(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT contract_cost_amortization_entry_fk
    FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id) DEFERRABLE
);

CREATE INDEX contract_cost_amortization_asset
  ON public.contract_cost_amortization (org_id, asset_id);

-- Amortization rows are posted history: they are written once by the
-- amortization run and never updated or deleted. Corrections are impairment
-- or reversal entries, never edits.
CREATE FUNCTION public.contract_cost_amortization_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $func$
BEGIN
  RAISE EXCEPTION 'Contract cost amortization is immutable; post an impairment or reversal entry instead.'
    USING ERRCODE = '23514';
  RETURN NULL;
END $func$;
CREATE TRIGGER contract_cost_amortization_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.contract_cost_amortization
  FOR EACH ROW EXECUTE FUNCTION public.contract_cost_amortization_immutable();

-- A capitalized amount and its amortization window are fixed once the run
-- has posted against the asset; later insight arrives as impairment.
CREATE FUNCTION public.contract_cost_asset_terms_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $func$
BEGIN
  IF (NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.amort_start_on IS DISTINCT FROM OLD.amort_start_on
      OR NEW.amort_end_on IS DISTINCT FROM OLD.amort_end_on
      OR NEW.method IS DISTINCT FROM OLD.method)
     AND EXISTS (SELECT 1 FROM public.contract_cost_amortization
                  WHERE org_id = OLD.org_id AND asset_id = OLD.id) THEN
    RAISE EXCEPTION 'A contract cost asset with posted amortization cannot change its amount, currency, method or amortization window; impair it instead.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $func$;
CREATE TRIGGER contract_cost_asset_terms_guard_trigger
  BEFORE UPDATE ON public.contract_cost_assets
  FOR EACH ROW EXECUTE FUNCTION public.contract_cost_asset_terms_guard();

-- Contract cost postings attribute their asset legs to the capitalized cost
-- they relieve, so the carrying amount is always the ledger itself. The
-- kernel's closed contributor vocabulary gains that one kind.
ALTER TABLE public.journal_lines DROP CONSTRAINT journal_lines_contributor_kind_check;
ALTER TABLE public.journal_lines ADD CONSTRAINT journal_lines_contributor_kind_check
  CHECK ((contributor_kind IS NULL) OR (contributor_kind = ANY (ARRAY['rule'::text, 'script'::text, 'app'::text, 'intercompany'::text, 'contract_cost_asset'::text])));

ALTER TABLE public.contract_cost_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_cost_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.contract_cost_policies
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.contract_cost_policies IS 'openbooks:org_isolation:v1';

ALTER TABLE public.contract_cost_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_cost_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.contract_cost_assets
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.contract_cost_assets IS 'openbooks:org_isolation:v1';

ALTER TABLE public.contract_cost_amortization ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_cost_amortization FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.contract_cost_amortization
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.contract_cost_amortization IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('contract_cost_policies', '0505_contract_costs'),
  ('contract_cost_assets', '0505_contract_costs'),
  ('contract_cost_amortization', '0505_contract_costs')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
