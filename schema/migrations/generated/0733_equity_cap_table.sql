-- Equity and cap table records per legal entity.
--
-- Share classes, equity plans, securities (share certificates, options,
-- restricted stock units, warrants, SAFEs and convertible notes), their
-- lifecycle events, class amendments, stock splits, financing rounds, the
-- effective-dated equity account policy and the stock-based compensation
-- runs. Every row belongs to one organization and one legal entity; child
-- rows reference their parents through composite keys that include the
-- legal entity, so a record can never attach to another entity's class,
-- plan, round or security.
--
-- Share counts are whole bigint quantities. Per-share prices (par value,
-- purchase and exercise prices, conversion prices) carry ten decimal places;
-- money carries the ledger's four.
--
-- Issued records are retained history. Corrections are new rows: a void or
-- cancellation event, a class amendment, a reserve change or a new account
-- policy version. A party merge may re-point a security's holder; nothing
-- else in a security changes after it is recorded.
--
-- Backfill: none. Every table starts empty.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.equity_share_classes (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 code text NOT NULL,
 name text NOT NULL,
 kind text NOT NULL,
 effective_on date NOT NULL,
 initial_authorized_shares bigint NOT NULL,
 par_value numeric(28,10) NOT NULL,
 original_issue_price numeric(28,10),
 initial_conversion_price numeric(28,10),
 liquidation_multiple numeric(10,4),
 participation text NOT NULL DEFAULT 'none',
 participation_cap_multiple numeric(10,4),
 seniority integer NOT NULL DEFAULT 0,
 anti_dilution text NOT NULL DEFAULT 'none',
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_share_classes_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_share_classes_entity_id_unique UNIQUE (org_id, subsidiary_id, id),
 CONSTRAINT equity_share_classes_code_unique UNIQUE (org_id, subsidiary_id, code),
 CONSTRAINT equity_share_classes_code CHECK (length(btrim(code)) BETWEEN 1 AND 40),
 CONSTRAINT equity_share_classes_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
 CONSTRAINT equity_share_classes_kind CHECK (kind IN ('common', 'preferred')),
 CONSTRAINT equity_share_classes_authorized CHECK (initial_authorized_shares > 0),
 CONSTRAINT equity_share_classes_par CHECK (par_value >= 0),
 CONSTRAINT equity_share_classes_participation CHECK (participation IN ('none', 'full', 'capped')),
 CONSTRAINT equity_share_classes_anti_dilution CHECK (anti_dilution IN ('none', 'broad_based', 'narrow_based', 'full_ratchet')),
 CONSTRAINT equity_share_classes_preferred_terms CHECK (
  (kind = 'common' AND original_issue_price IS NULL AND initial_conversion_price IS NULL AND liquidation_multiple IS NULL
    AND participation = 'none' AND participation_cap_multiple IS NULL AND anti_dilution = 'none')
  OR (kind = 'preferred' AND original_issue_price > 0 AND initial_conversion_price > 0 AND liquidation_multiple >= 0)),
 CONSTRAINT equity_share_classes_cap CHECK (
  (participation = 'capped' AND participation_cap_multiple IS NOT NULL AND participation_cap_multiple > coalesce(liquidation_multiple, 0))
  OR (participation <> 'capped' AND participation_cap_multiple IS NULL)),
 CONSTRAINT equity_share_classes_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT equity_share_classes_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE TABLE public.equity_class_amendments (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 share_class_id uuid NOT NULL,
 kind text NOT NULL,
 effective_on date NOT NULL,
 authorized_shares bigint,
 conversion_price numeric(28,10),
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_class_amendments_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_class_amendments_kind CHECK (kind IN ('authorized_shares', 'conversion_price')),
 CONSTRAINT equity_class_amendments_value CHECK (
  (kind = 'authorized_shares' AND authorized_shares > 0 AND conversion_price IS NULL)
  OR (kind = 'conversion_price' AND conversion_price > 0 AND authorized_shares IS NULL)),
 CONSTRAINT equity_class_amendments_reason CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
 CONSTRAINT equity_class_amendments_class_fkey FOREIGN KEY (org_id, subsidiary_id, share_class_id)
  REFERENCES public.equity_share_classes(org_id, subsidiary_id, id),
 CONSTRAINT equity_class_amendments_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX equity_class_amendments_class ON public.equity_class_amendments (org_id, share_class_id, effective_on);

CREATE TABLE public.equity_plans (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 code text NOT NULL,
 name text NOT NULL,
 share_class_id uuid NOT NULL,
 effective_on date NOT NULL,
 initial_reserved_shares bigint NOT NULL,
 recycle_forfeited boolean NOT NULL,
 recycle_expired boolean NOT NULL,
 recycle_repurchased boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_plans_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_plans_entity_id_unique UNIQUE (org_id, subsidiary_id, id),
 CONSTRAINT equity_plans_code_unique UNIQUE (org_id, subsidiary_id, code),
 CONSTRAINT equity_plans_code CHECK (length(btrim(code)) BETWEEN 1 AND 40),
 CONSTRAINT equity_plans_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
 CONSTRAINT equity_plans_reserved CHECK (initial_reserved_shares > 0),
 CONSTRAINT equity_plans_class_fkey FOREIGN KEY (org_id, subsidiary_id, share_class_id)
  REFERENCES public.equity_share_classes(org_id, subsidiary_id, id),
 CONSTRAINT equity_plans_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE TABLE public.equity_plan_reserve_changes (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 plan_id uuid NOT NULL,
 effective_on date NOT NULL,
 share_delta bigint NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_plan_reserve_changes_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_plan_reserve_changes_delta CHECK (share_delta <> 0),
 CONSTRAINT equity_plan_reserve_changes_reason CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
 CONSTRAINT equity_plan_reserve_changes_plan_fkey FOREIGN KEY (org_id, subsidiary_id, plan_id)
  REFERENCES public.equity_plans(org_id, subsidiary_id, id),
 CONSTRAINT equity_plan_reserve_changes_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX equity_plan_reserve_changes_plan ON public.equity_plan_reserve_changes (org_id, plan_id, effective_on);

CREATE TABLE public.equity_financing_rounds (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 name text NOT NULL,
 share_class_id uuid NOT NULL,
 closed_on date NOT NULL,
 price_per_share numeric(28,10) NOT NULL,
 pre_money_valuation numeric(19,4) NOT NULL,
 currency text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_financing_rounds_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_financing_rounds_entity_id_unique UNIQUE (org_id, subsidiary_id, id),
 CONSTRAINT equity_financing_rounds_name_unique UNIQUE (org_id, subsidiary_id, name),
 CONSTRAINT equity_financing_rounds_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
 CONSTRAINT equity_financing_rounds_price CHECK (price_per_share > 0),
 CONSTRAINT equity_financing_rounds_pre_money CHECK (pre_money_valuation > 0),
 CONSTRAINT equity_financing_rounds_class_fkey FOREIGN KEY (org_id, subsidiary_id, share_class_id)
  REFERENCES public.equity_share_classes(org_id, subsidiary_id, id),
 CONSTRAINT equity_financing_rounds_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE TABLE public.equity_securities (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 security_number text NOT NULL,
 kind text NOT NULL,
 holder_party_id uuid NOT NULL,
 share_class_id uuid,
 plan_id uuid,
 round_id uuid,
 source_security_id uuid,
 issue_date date NOT NULL,
 quantity bigint,
 price_per_share numeric(28,10),
 consideration_amount numeric(19,4),
 currency text NOT NULL,
 consideration_account_id uuid,
 vesting_start date,
 vesting_months integer,
 cliff_months integer,
 vesting_frequency text,
 vesting_tranches jsonb,
 acceleration text NOT NULL DEFAULT 'none',
 acceleration_percent numeric(9,4),
 expiration_date date,
 option_type text,
 early_exercise boolean NOT NULL DEFAULT false,
 safe_type text,
 valuation_cap numeric(19,4),
 discount_percent numeric(9,4),
 interest_rate_percent numeric(9,4),
 interest_basis text,
 maturity_date date,
 valuation_method text,
 valuation_share_price numeric(28,10),
 volatility_percent numeric(9,4),
 risk_free_rate_percent numeric(9,4),
 expected_term_years numeric(9,4),
 dividend_yield_percent numeric(9,4),
 fair_value_per_unit numeric(28,10),
 expense_attribution text,
 memo text,
 journal_entry_id uuid,
 idempotency_key text,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_securities_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_securities_entity_id_unique UNIQUE (org_id, subsidiary_id, id),
 CONSTRAINT equity_securities_number_unique UNIQUE (org_id, subsidiary_id, security_number),
 CONSTRAINT equity_securities_idempotency_unique UNIQUE (org_id, idempotency_key),
 CONSTRAINT equity_securities_number CHECK (length(btrim(security_number)) BETWEEN 1 AND 40),
 CONSTRAINT equity_securities_kind CHECK (kind IN ('share', 'option', 'rsu', 'warrant', 'safe', 'note')),
 CONSTRAINT equity_securities_quantity_shape CHECK (
  (kind IN ('share', 'option', 'rsu', 'warrant') AND quantity > 0 AND share_class_id IS NOT NULL)
  OR (kind IN ('safe', 'note') AND quantity IS NULL AND consideration_amount > 0)),
 CONSTRAINT equity_securities_price CHECK (price_per_share IS NULL OR price_per_share >= 0),
 CONSTRAINT equity_securities_exercise_price CHECK (kind NOT IN ('option', 'warrant') OR price_per_share IS NOT NULL),
 CONSTRAINT equity_securities_consideration CHECK (consideration_amount IS NULL OR consideration_amount >= 0),
 CONSTRAINT equity_securities_plan_kind CHECK (plan_id IS NULL OR kind IN ('option', 'rsu')),
 CONSTRAINT equity_securities_vesting_frequency CHECK (vesting_frequency IS NULL OR vesting_frequency IN ('monthly', 'quarterly', 'annual')),
 CONSTRAINT equity_securities_vesting_shape CHECK (
  (vesting_months IS NULL AND cliff_months IS NULL AND vesting_frequency IS NULL)
  OR (vesting_months BETWEEN 1 AND 600 AND cliff_months BETWEEN 0 AND vesting_months AND vesting_frequency IS NOT NULL AND vesting_start IS NOT NULL)),
 CONSTRAINT equity_securities_vesting_exclusive CHECK (vesting_tranches IS NULL OR (vesting_months IS NULL AND jsonb_typeof(vesting_tranches) = 'array')),
 CONSTRAINT equity_securities_vesting_kind CHECK (kind IN ('share', 'option', 'rsu') OR (vesting_months IS NULL AND vesting_tranches IS NULL)),
 CONSTRAINT equity_securities_acceleration CHECK (acceleration IN ('none', 'single', 'double')),
 CONSTRAINT equity_securities_acceleration_percent CHECK (
  (acceleration = 'none' AND acceleration_percent IS NULL)
  OR (acceleration <> 'none' AND acceleration_percent > 0 AND acceleration_percent <= 100)),
 CONSTRAINT equity_securities_option_type CHECK (
  (kind = 'option' AND option_type IN ('iso', 'nso')) OR (kind <> 'option' AND option_type IS NULL)),
 CONSTRAINT equity_securities_early_exercise CHECK (NOT early_exercise OR kind = 'option'),
 CONSTRAINT equity_securities_safe_terms CHECK (
  (kind = 'safe' AND safe_type IN ('pre_money', 'post_money')) OR (kind <> 'safe' AND safe_type IS NULL)),
 CONSTRAINT equity_securities_convertible_terms CHECK (
  kind IN ('safe', 'note') OR (valuation_cap IS NULL AND discount_percent IS NULL)),
 CONSTRAINT equity_securities_cap CHECK (valuation_cap IS NULL OR valuation_cap > 0),
 CONSTRAINT equity_securities_discount CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent < 100)),
 CONSTRAINT equity_securities_note_terms CHECK (
  (kind = 'note' AND interest_rate_percent >= 0 AND interest_basis IN ('simple', 'compound_annual'))
  OR (kind <> 'note' AND interest_rate_percent IS NULL AND interest_basis IS NULL AND maturity_date IS NULL)),
 CONSTRAINT equity_securities_valuation_method CHECK (valuation_method IS NULL OR valuation_method IN ('black_scholes', 'share_price')),
 CONSTRAINT equity_securities_compensatory_valuation CHECK (
  (kind = 'option' AND valuation_method = 'black_scholes' AND valuation_share_price > 0 AND volatility_percent > 0
    AND risk_free_rate_percent IS NOT NULL AND expected_term_years > 0 AND dividend_yield_percent >= 0
    AND fair_value_per_unit >= 0 AND expense_attribution IS NOT NULL)
  OR (kind = 'rsu' AND valuation_method = 'share_price' AND valuation_share_price > 0
    AND fair_value_per_unit >= 0 AND expense_attribution IS NOT NULL)
  OR (kind NOT IN ('option', 'rsu') AND valuation_method IS NULL AND fair_value_per_unit IS NULL AND expense_attribution IS NULL)),
 CONSTRAINT equity_securities_attribution CHECK (expense_attribution IS NULL OR expense_attribution IN ('straight_line', 'graded')),
 CONSTRAINT equity_securities_memo CHECK (memo IS NULL OR length(memo) <= 2000),
 CONSTRAINT equity_securities_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT equity_securities_holder_fkey FOREIGN KEY (org_id, holder_party_id) REFERENCES public.parties(org_id, id),
 CONSTRAINT equity_securities_class_fkey FOREIGN KEY (org_id, subsidiary_id, share_class_id)
  REFERENCES public.equity_share_classes(org_id, subsidiary_id, id),
 CONSTRAINT equity_securities_plan_fkey FOREIGN KEY (org_id, subsidiary_id, plan_id)
  REFERENCES public.equity_plans(org_id, subsidiary_id, id),
 CONSTRAINT equity_securities_round_fkey FOREIGN KEY (org_id, subsidiary_id, round_id)
  REFERENCES public.equity_financing_rounds(org_id, subsidiary_id, id),
 CONSTRAINT equity_securities_source_fkey FOREIGN KEY (org_id, subsidiary_id, source_security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id),
 CONSTRAINT equity_securities_consideration_account_fkey FOREIGN KEY (org_id, consideration_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_securities_journal_entry_fkey FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT equity_securities_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX equity_securities_entity_kind ON public.equity_securities (org_id, subsidiary_id, kind, issue_date);
CREATE INDEX equity_securities_holder ON public.equity_securities (org_id, holder_party_id);
CREATE INDEX equity_securities_class ON public.equity_securities (org_id, share_class_id);
CREATE INDEX equity_securities_plan ON public.equity_securities (org_id, plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX equity_securities_source ON public.equity_securities (org_id, source_security_id) WHERE source_security_id IS NOT NULL;

CREATE TABLE public.equity_security_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 security_id uuid NOT NULL,
 kind text NOT NULL,
 effective_on date NOT NULL,
 quantity bigint,
 price_per_share numeric(28,10),
 amount numeric(19,4),
 resulting_security_id uuid,
 round_id uuid,
 consideration_account_id uuid,
 journal_entry_id uuid,
 reversal_entry_id uuid,
 reason text,
 idempotency_key text,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_security_events_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_security_events_idempotency_unique UNIQUE (org_id, idempotency_key),
 CONSTRAINT equity_security_events_kind CHECK (kind IN ('exercise', 'settle', 'forfeit', 'expire', 'cancel', 'repurchase', 'transfer', 'convert', 'void')),
 CONSTRAINT equity_security_events_quantity CHECK (quantity IS NULL OR quantity > 0),
 CONSTRAINT equity_security_events_quantity_required CHECK (kind IN ('void', 'convert') OR quantity IS NOT NULL),
 CONSTRAINT equity_security_events_price CHECK (price_per_share IS NULL OR price_per_share >= 0),
 CONSTRAINT equity_security_events_amount CHECK (amount IS NULL OR amount >= 0),
 CONSTRAINT equity_security_events_result CHECK (
  (kind IN ('exercise', 'settle', 'transfer', 'convert') AND resulting_security_id IS NOT NULL)
  OR (kind NOT IN ('exercise', 'settle', 'transfer', 'convert') AND resulting_security_id IS NULL)),
 CONSTRAINT equity_security_events_reason CHECK (
  (kind IN ('forfeit', 'expire', 'cancel', 'repurchase', 'void') AND length(btrim(reason)) BETWEEN 5 AND 2000)
  OR (kind NOT IN ('forfeit', 'expire', 'cancel', 'repurchase', 'void') AND (reason IS NULL OR length(reason) <= 2000))),
 CONSTRAINT equity_security_events_security_fkey FOREIGN KEY (org_id, subsidiary_id, security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id),
 CONSTRAINT equity_security_events_result_fkey FOREIGN KEY (org_id, subsidiary_id, resulting_security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id),
 CONSTRAINT equity_security_events_round_fkey FOREIGN KEY (org_id, subsidiary_id, round_id)
  REFERENCES public.equity_financing_rounds(org_id, subsidiary_id, id),
 CONSTRAINT equity_security_events_consideration_account_fkey FOREIGN KEY (org_id, consideration_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_security_events_journal_entry_fkey FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT equity_security_events_reversal_entry_fkey FOREIGN KEY (org_id, reversal_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT equity_security_events_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE UNIQUE INDEX equity_security_events_one_void ON public.equity_security_events (org_id, security_id) WHERE kind = 'void';
CREATE INDEX equity_security_events_security ON public.equity_security_events (org_id, security_id, effective_on);
CREATE INDEX equity_security_events_entity ON public.equity_security_events (org_id, subsidiary_id, effective_on);

CREATE TABLE public.equity_splits (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 share_class_id uuid NOT NULL,
 effective_on date NOT NULL,
 ratio_numerator bigint NOT NULL,
 ratio_denominator bigint NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_splits_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_splits_class_date_unique UNIQUE (org_id, share_class_id, effective_on),
 CONSTRAINT equity_splits_ratio CHECK (ratio_numerator > 0 AND ratio_denominator > 0 AND ratio_numerator <> ratio_denominator),
 CONSTRAINT equity_splits_reason CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
 CONSTRAINT equity_splits_class_fkey FOREIGN KEY (org_id, subsidiary_id, share_class_id)
  REFERENCES public.equity_share_classes(org_id, subsidiary_id, id),
 CONSTRAINT equity_splits_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE TABLE public.equity_account_policies (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 effective_from date NOT NULL,
 common_stock_account_id uuid NOT NULL,
 preferred_stock_account_id uuid NOT NULL,
 apic_account_id uuid NOT NULL,
 apic_share_based_account_id uuid NOT NULL,
 compensation_expense_account_id uuid NOT NULL,
 treasury_stock_account_id uuid NOT NULL,
 convertible_instruments_account_id uuid NOT NULL,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 CONSTRAINT equity_account_policies_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_account_policies_version_unique UNIQUE (org_id, subsidiary_id, effective_from),
 CONSTRAINT equity_account_policies_reason CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
 CONSTRAINT equity_account_policies_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT equity_account_policies_common_fkey FOREIGN KEY (org_id, common_stock_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_account_policies_preferred_fkey FOREIGN KEY (org_id, preferred_stock_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_account_policies_apic_fkey FOREIGN KEY (org_id, apic_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_account_policies_apic_share_based_fkey FOREIGN KEY (org_id, apic_share_based_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_account_policies_expense_fkey FOREIGN KEY (org_id, compensation_expense_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_account_policies_treasury_fkey FOREIGN KEY (org_id, treasury_stock_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_account_policies_convertible_fkey FOREIGN KEY (org_id, convertible_instruments_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT equity_account_policies_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE,
 CONSTRAINT equity_account_policies_updated_by_fkey FOREIGN KEY (org_id, updated_by) REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE TABLE public.equity_compensation_runs (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 through_date date NOT NULL,
 currency text NOT NULL,
 total_amount numeric(19,4) NOT NULL,
 journal_entry_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_compensation_runs_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_compensation_runs_entity_id_unique UNIQUE (org_id, subsidiary_id, id),
 CONSTRAINT equity_compensation_runs_through_unique UNIQUE (org_id, subsidiary_id, through_date),
 CONSTRAINT equity_compensation_runs_entry CHECK ((total_amount = 0) = (journal_entry_id IS NULL)),
 CONSTRAINT equity_compensation_runs_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT equity_compensation_runs_journal_entry_fkey FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT equity_compensation_runs_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE TABLE public.equity_compensation_run_lines (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 run_id uuid NOT NULL,
 security_id uuid NOT NULL,
 cumulative_amount numeric(19,4) NOT NULL,
 previous_amount numeric(19,4) NOT NULL,
 period_amount numeric(19,4) NOT NULL,
 CONSTRAINT equity_compensation_run_lines_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_compensation_run_lines_security_unique UNIQUE (org_id, run_id, security_id),
 CONSTRAINT equity_compensation_run_lines_delta CHECK (period_amount = cumulative_amount - previous_amount),
 CONSTRAINT equity_compensation_run_lines_run_fkey FOREIGN KEY (org_id, subsidiary_id, run_id)
  REFERENCES public.equity_compensation_runs(org_id, subsidiary_id, id),
 CONSTRAINT equity_compensation_run_lines_security_fkey FOREIGN KEY (org_id, subsidiary_id, security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id)
);
CREATE INDEX equity_compensation_run_lines_security ON public.equity_compensation_run_lines (org_id, security_id);

-- Equity records are retained history. A security's holder follows a
-- governed party merge; every other change is a new record. Rows leave only
-- through tenant retirement or an approved sandbox wipe.
CREATE FUNCTION public.equity_record_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='equity_securities' AND (to_jsonb(NEW)-'holder_party_id')=(to_jsonb(OLD)-'holder_party_id') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Equity records are retained history. Record a void, cancellation or amendment instead.' USING ERRCODE='23514';
END $$;

DO $tables$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('equity_share_classes'),
('equity_class_amendments'),
('equity_plans'),
('equity_plan_reserve_changes'),
('equity_financing_rounds'),
('equity_securities'),
('equity_security_events'),
('equity_splits'),
('equity_account_policies'),
('equity_compensation_runs'),
('equity_compensation_run_lines')
 ) AS expected(table_name) LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true))) WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true)))', target.table_name);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''', target.table_name);
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', target.table_name);
  IF target.table_name = 'equity_account_policies' THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable()', target.table_name || '_immutable', target.table_name);
  ELSE
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.equity_record_immutable()', target.table_name || '_immutable', target.table_name);
  END IF;
 END LOOP;
END $tables$;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('equity_share_classes', '0733_equity_cap_table'),
 ('equity_class_amendments', '0733_equity_cap_table'),
 ('equity_plans', '0733_equity_cap_table'),
 ('equity_plan_reserve_changes', '0733_equity_cap_table'),
 ('equity_financing_rounds', '0733_equity_cap_table'),
 ('equity_securities', '0733_equity_cap_table'),
 ('equity_security_events', '0733_equity_cap_table'),
 ('equity_splits', '0733_equity_cap_table'),
 ('equity_account_policies', '0733_equity_cap_table'),
 ('equity_compensation_runs', '0733_equity_cap_table'),
 ('equity_compensation_run_lines', '0733_equity_cap_table')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
