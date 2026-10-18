-- Equity instrument lifecycle: MFN elections, note interest conventions and
-- accrual runs, early exercise with restricted stock releases, governed
-- reversal of a single event, convertible repayment and cancellation,
-- conversion-class terms of preferred stock and foreign-currency instruments.
--
-- Share classes name the common class a preferred class converts into and
-- whether its conversion price adjusts for that class's splits. A class
-- amendment can record the conversion class from a date.
--
-- Securities gain the MFN term of a SAFE, the day-count convention and
-- compounding period of a note, the repurchase price basis of unvested shares
-- bought by early exercise, and the exchange rate that measured the security
-- in the legal entity's functional currency on its issue date. Every note
-- already recorded accrued Actual/365 interest, so its day count is recorded
-- as actual_365; every security already recorded is in the functional
-- currency, so its rate is 1.
--
-- Security events gain repayment, reversal and 83(b) election kinds. A
-- reversal names the one event it undoes. Repayments and convertible
-- cancellations carry their settled amount instead of a share quantity. Events
-- also record the accrued interest they settle, the interest accrued to their
-- date and its entry, the early-exercise deposit, the fair market value a
-- restricted repurchase was priced against and the exchange rate applied.
--
-- An MFN election is a security amendment: the later instrument whose terms
-- were adopted, the adopted cap, discount and SAFE type, the effective date
-- and the reason. Interest runs accrue note interest through a date with one
-- line per note. Compensation runs also release early-exercise deposits to
-- equity as restricted shares vest, with one release line per certificate.
--
-- Equity account policies gain the interest expense, accrued interest and
-- early-exercise deposit accounts; earlier versions are unchanged.
--
-- Backfill: equity_securities.interest_day_count = 'actual_365' for notes.
SET statement_timeout = 0;
SET lock_timeout = '10s';
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.equity_share_classes
 ADD COLUMN conversion_share_class_id uuid,
 ADD COLUMN conversion_adjusts_for_splits boolean NOT NULL DEFAULT true,
 ADD CONSTRAINT equity_share_classes_conversion_class CHECK (
  conversion_share_class_id IS NULL OR (kind = 'preferred' AND conversion_share_class_id <> id)),
 ADD CONSTRAINT equity_share_classes_conversion_class_fkey FOREIGN KEY (org_id, subsidiary_id, conversion_share_class_id)
  REFERENCES public.equity_share_classes(org_id, subsidiary_id, id);

ALTER TABLE public.equity_class_amendments
 ADD COLUMN conversion_share_class_id uuid,
 DROP CONSTRAINT equity_class_amendments_kind,
 DROP CONSTRAINT equity_class_amendments_value,
 ADD CONSTRAINT equity_class_amendments_kind CHECK (kind IN ('authorized_shares', 'conversion_price', 'conversion_class')),
 ADD CONSTRAINT equity_class_amendments_value CHECK (
  (kind = 'authorized_shares' AND authorized_shares > 0 AND conversion_price IS NULL AND conversion_share_class_id IS NULL)
  OR (kind = 'conversion_price' AND conversion_price > 0 AND authorized_shares IS NULL AND conversion_share_class_id IS NULL)
  OR (kind = 'conversion_class' AND conversion_share_class_id IS NOT NULL AND authorized_shares IS NULL AND conversion_price IS NULL)),
 ADD CONSTRAINT equity_class_amendments_conversion_class_fkey FOREIGN KEY (org_id, subsidiary_id, conversion_share_class_id)
  REFERENCES public.equity_share_classes(org_id, subsidiary_id, id);

ALTER TABLE public.equity_securities
 ADD COLUMN mfn boolean NOT NULL DEFAULT false,
 ADD COLUMN interest_day_count text,
 ADD COLUMN unvested_repurchase_basis text,
 ADD COLUMN fx_rate numeric(19,10) NOT NULL DEFAULT 1;

-- Notes already recorded accrued on an Actual/365 day count; recording that
-- convention changes no recorded amount. The retention guard is suspended for
-- this assignment only, under the migration transaction's table lock.
ALTER TABLE public.equity_securities DISABLE TRIGGER equity_securities_immutable;
UPDATE public.equity_securities SET interest_day_count = 'actual_365' WHERE kind = 'note' AND interest_day_count IS NULL;
ALTER TABLE public.equity_securities ENABLE TRIGGER equity_securities_immutable;

ALTER TABLE public.equity_securities
 DROP CONSTRAINT equity_securities_note_terms,
 ADD CONSTRAINT equity_securities_note_terms CHECK (
  (kind = 'note' AND interest_rate_percent >= 0
    AND interest_basis IN ('simple', 'compound_annual', 'compound_semiannual', 'compound_quarterly', 'compound_monthly')
    AND interest_day_count IN ('actual_365', 'actual_360', 'thirty_360', 'actual_actual'))
  OR (kind <> 'note' AND interest_rate_percent IS NULL AND interest_basis IS NULL AND maturity_date IS NULL AND interest_day_count IS NULL)),
 ADD CONSTRAINT equity_securities_mfn CHECK (NOT mfn OR kind = 'safe'),
 ADD CONSTRAINT equity_securities_repurchase_basis CHECK (
  unvested_repurchase_basis IS NULL
  OR (kind = 'option' AND early_exercise AND unvested_repurchase_basis IN ('cost', 'lower_of_cost_or_fmv'))),
 ADD CONSTRAINT equity_securities_fx_rate CHECK (fx_rate > 0);

ALTER TABLE public.equity_security_events
 ADD COLUMN reverses_event_id uuid,
 ADD COLUMN interest_amount numeric(19,4),
 ADD COLUMN interest_accrued_amount numeric(19,4),
 ADD COLUMN interest_accrued_functional numeric(19,4),
 ADD COLUMN interest_accrual_entry_id uuid,
 ADD COLUMN deposit_amount numeric(19,4),
 ADD COLUMN fair_market_value numeric(28,10),
 ADD COLUMN fx_rate numeric(19,10),
 DROP CONSTRAINT equity_security_events_kind,
 DROP CONSTRAINT equity_security_events_quantity_required,
 DROP CONSTRAINT equity_security_events_reason,
 ADD CONSTRAINT equity_security_events_kind CHECK (kind IN (
  'exercise', 'settle', 'forfeit', 'expire', 'cancel', 'repurchase', 'transfer', 'convert', 'void', 'repay', 'reverse', 'election_83b')),
 ADD CONSTRAINT equity_security_events_quantity_required CHECK (
  (kind IN ('exercise', 'settle', 'forfeit', 'expire', 'transfer', 'repurchase') AND quantity IS NOT NULL)
  OR (kind = 'cancel' AND (quantity IS NULL) <> (amount IS NULL))
  OR (kind = 'repay' AND quantity IS NULL AND amount IS NOT NULL)
  OR (kind IN ('reverse', 'election_83b') AND quantity IS NULL AND amount IS NULL)
  OR kind IN ('void', 'convert')),
 ADD CONSTRAINT equity_security_events_reason CHECK (
  (kind IN ('forfeit', 'expire', 'cancel', 'repurchase', 'void', 'reverse') AND length(btrim(reason)) BETWEEN 5 AND 2000)
  OR (kind NOT IN ('forfeit', 'expire', 'cancel', 'repurchase', 'void', 'reverse') AND (reason IS NULL OR length(reason) <= 2000))),
 ADD CONSTRAINT equity_security_events_reversal CHECK ((kind = 'reverse') = (reverses_event_id IS NOT NULL) AND reverses_event_id IS DISTINCT FROM id),
 ADD CONSTRAINT equity_security_events_interest CHECK (
  (interest_amount IS NULL OR interest_amount >= 0)
  AND ((interest_accrued_amount IS NULL) = (interest_accrued_functional IS NULL))
  AND (interest_accrual_entry_id IS NULL OR interest_accrued_amount IS NOT NULL)),
 ADD CONSTRAINT equity_security_events_deposit CHECK (deposit_amount IS NULL OR (deposit_amount >= 0 AND kind IN ('exercise', 'repurchase'))),
 ADD CONSTRAINT equity_security_events_fair_market_value CHECK (fair_market_value IS NULL OR (fair_market_value >= 0 AND kind = 'repurchase')),
 ADD CONSTRAINT equity_security_events_fx_rate CHECK (fx_rate IS NULL OR fx_rate > 0),
 ADD CONSTRAINT equity_security_events_reverses_fkey FOREIGN KEY (org_id, reverses_event_id) REFERENCES public.equity_security_events(org_id, id),
 ADD CONSTRAINT equity_security_events_accrual_entry_fkey FOREIGN KEY (org_id, interest_accrual_entry_id) REFERENCES public.journal_entries(org_id, id);
CREATE UNIQUE INDEX equity_security_events_one_reversal ON public.equity_security_events (org_id, reverses_event_id) WHERE reverses_event_id IS NOT NULL;

ALTER TABLE public.equity_account_policies
 ADD COLUMN interest_expense_account_id uuid,
 ADD COLUMN accrued_interest_account_id uuid,
 ADD COLUMN early_exercise_deposit_account_id uuid,
 ADD CONSTRAINT equity_account_policies_interest_expense_fkey FOREIGN KEY (org_id, interest_expense_account_id) REFERENCES public.accounts(org_id, id),
 ADD CONSTRAINT equity_account_policies_accrued_interest_fkey FOREIGN KEY (org_id, accrued_interest_account_id) REFERENCES public.accounts(org_id, id),
 ADD CONSTRAINT equity_account_policies_deposit_fkey FOREIGN KEY (org_id, early_exercise_deposit_account_id) REFERENCES public.accounts(org_id, id);

ALTER TABLE public.equity_compensation_runs
 ADD COLUMN release_amount numeric(19,4) NOT NULL DEFAULT 0,
 ADD COLUMN release_journal_entry_id uuid,
 ADD CONSTRAINT equity_compensation_runs_release_entry_fkey FOREIGN KEY (org_id, release_journal_entry_id) REFERENCES public.journal_entries(org_id, id);

CREATE TABLE public.equity_security_amendments (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 security_id uuid NOT NULL,
 kind text NOT NULL,
 effective_on date NOT NULL,
 source_security_id uuid NOT NULL,
 valuation_cap numeric(19,4),
 discount_percent numeric(9,4),
 safe_type text NOT NULL,
 reason text NOT NULL,
 idempotency_key text,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_security_amendments_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_security_amendments_idempotency_unique UNIQUE (org_id, idempotency_key),
 CONSTRAINT equity_security_amendments_kind CHECK (kind = 'mfn_election'),
 CONSTRAINT equity_security_amendments_source CHECK (source_security_id <> security_id),
 CONSTRAINT equity_security_amendments_terms CHECK (valuation_cap IS NOT NULL OR discount_percent IS NOT NULL),
 CONSTRAINT equity_security_amendments_cap CHECK (valuation_cap IS NULL OR valuation_cap > 0),
 CONSTRAINT equity_security_amendments_discount CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent < 100)),
 CONSTRAINT equity_security_amendments_safe_type CHECK (safe_type IN ('pre_money', 'post_money')),
 CONSTRAINT equity_security_amendments_reason CHECK (length(btrim(reason)) BETWEEN 5 AND 2000),
 CONSTRAINT equity_security_amendments_security_fkey FOREIGN KEY (org_id, subsidiary_id, security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id),
 CONSTRAINT equity_security_amendments_source_fkey FOREIGN KEY (org_id, subsidiary_id, source_security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id),
 CONSTRAINT equity_security_amendments_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX equity_security_amendments_security ON public.equity_security_amendments (org_id, security_id, effective_on);

CREATE TABLE public.equity_interest_runs (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 through_date date NOT NULL,
 currency text NOT NULL,
 total_amount numeric(19,4) NOT NULL,
 journal_entry_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 CONSTRAINT equity_interest_runs_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_interest_runs_entity_id_unique UNIQUE (org_id, subsidiary_id, id),
 CONSTRAINT equity_interest_runs_through_unique UNIQUE (org_id, subsidiary_id, through_date),
 CONSTRAINT equity_interest_runs_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT equity_interest_runs_journal_entry_fkey FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT equity_interest_runs_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE TABLE public.equity_interest_run_lines (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 run_id uuid NOT NULL,
 security_id uuid NOT NULL,
 currency text NOT NULL,
 cumulative_amount numeric(19,4) NOT NULL,
 previous_amount numeric(19,4) NOT NULL,
 period_amount numeric(19,4) NOT NULL,
 fx_rate numeric(19,10),
 functional_amount numeric(19,4) NOT NULL,
 CONSTRAINT equity_interest_run_lines_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_interest_run_lines_security_unique UNIQUE (org_id, run_id, security_id),
 CONSTRAINT equity_interest_run_lines_delta CHECK (period_amount = cumulative_amount - previous_amount AND cumulative_amount >= 0),
 CONSTRAINT equity_interest_run_lines_rate CHECK ((fx_rate IS NULL) = (period_amount < 0) AND (fx_rate IS NULL OR fx_rate > 0)),
 CONSTRAINT equity_interest_run_lines_run_fkey FOREIGN KEY (org_id, subsidiary_id, run_id)
  REFERENCES public.equity_interest_runs(org_id, subsidiary_id, id),
 CONSTRAINT equity_interest_run_lines_security_fkey FOREIGN KEY (org_id, subsidiary_id, security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id)
);
CREATE INDEX equity_interest_run_lines_security ON public.equity_interest_run_lines (org_id, security_id);

CREATE TABLE public.equity_compensation_run_releases (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,
 run_id uuid NOT NULL,
 security_id uuid NOT NULL,
 cumulative_shares bigint NOT NULL,
 previous_shares bigint NOT NULL,
 cumulative_deposit numeric(19,4) NOT NULL,
 period_deposit numeric(19,4) NOT NULL,
 cumulative_reclass numeric(19,4) NOT NULL,
 period_reclass numeric(19,4) NOT NULL,
 cumulative_par numeric(19,4) NOT NULL,
 period_par numeric(19,4) NOT NULL,
 CONSTRAINT equity_compensation_run_releases_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT equity_compensation_run_releases_security_unique UNIQUE (org_id, run_id, security_id),
 CONSTRAINT equity_compensation_run_releases_amounts CHECK (
  cumulative_shares >= 0 AND previous_shares >= 0 AND cumulative_deposit >= 0 AND cumulative_reclass >= 0 AND cumulative_par >= 0),
 CONSTRAINT equity_compensation_run_releases_run_fkey FOREIGN KEY (org_id, subsidiary_id, run_id)
  REFERENCES public.equity_compensation_runs(org_id, subsidiary_id, id),
 CONSTRAINT equity_compensation_run_releases_security_fkey FOREIGN KEY (org_id, subsidiary_id, security_id)
  REFERENCES public.equity_securities(org_id, subsidiary_id, id)
);
CREATE INDEX equity_compensation_run_releases_security ON public.equity_compensation_run_releases (org_id, security_id);

DO $tables$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('equity_security_amendments'),
('equity_interest_runs'),
('equity_interest_run_lines'),
('equity_compensation_run_releases')
 ) AS expected(table_name) LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true))) WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true)))', target.table_name);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''', target.table_name);
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', target.table_name);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.equity_record_immutable()', target.table_name || '_immutable', target.table_name);
 END LOOP;
END $tables$;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('equity_security_amendments', '0738_equity_instrument_lifecycle'),
 ('equity_interest_runs', '0738_equity_instrument_lifecycle'),
 ('equity_interest_run_lines', '0738_equity_instrument_lifecycle'),
 ('equity_compensation_run_releases', '0738_equity_instrument_lifecycle')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
