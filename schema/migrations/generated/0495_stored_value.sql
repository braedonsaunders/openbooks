-- Stored-value ledger: gift cards and store credit are liabilities, never revenue.
-- Selling a gift card credits the gift card liability; redeeming debits it.
-- Breakage follows ASC 606-10-55-48 (proportional or remote recognition).
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.stored_value_programs (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 name text NOT NULL, kind text NOT NULL,
 liability_account_id uuid, breakage_income_account_id uuid,
 breakage_policy text NOT NULL DEFAULT 'none',
 breakage_rate numeric(19,10) NOT NULL DEFAULT 0,
 expiry_months integer, inactivity_months integer NOT NULL DEFAULT 24,
 currency text, is_active boolean NOT NULL DEFAULT true,
 custom jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id), UNIQUE(org_id,kind,name),
 CONSTRAINT stored_value_program_kind CHECK(kind IN ('gift_card','store_credit')),
 CONSTRAINT stored_value_program_breakage_policy CHECK(breakage_policy IN ('none','proportional','remote')),
 CONSTRAINT stored_value_program_breakage_rate CHECK(breakage_rate >= 0 AND breakage_rate < 1),
 CONSTRAINT stored_value_program_proportional_rate CHECK(breakage_policy <> 'proportional' OR breakage_rate > 0),
 CONSTRAINT stored_value_program_breakage_income CHECK(breakage_policy = 'none' OR breakage_income_account_id IS NOT NULL),
 CONSTRAINT stored_value_program_expiry_months CHECK(expiry_months IS NULL OR expiry_months > 0),
 CONSTRAINT stored_value_program_inactivity_months CHECK(inactivity_months > 0),
 FOREIGN KEY(org_id,liability_account_id) REFERENCES public.accounts(org_id,id),
 FOREIGN KEY(org_id,breakage_income_account_id) REFERENCES public.accounts(org_id,id)
);
ALTER TABLE public.stored_value_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stored_value_programs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.stored_value_programs
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.stored_value_programs IS 'openbooks:org_isolation:v1';

CREATE TABLE public.stored_value_accounts (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 program_id uuid NOT NULL, kind text NOT NULL,
 code_hash text NOT NULL, code_last4 text NOT NULL,
 customer_party_id uuid, currency text NOT NULL,
 issued_minor bigint NOT NULL DEFAULT 0, balance_minor bigint NOT NULL DEFAULT 0,
 breakage_recognized_minor bigint NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'active',
 expires_on date, last_activity_on date NOT NULL DEFAULT CURRENT_DATE,
 source_document_id uuid, liability_account_id uuid,
 custom jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id), UNIQUE(org_id,code_hash),
 CONSTRAINT stored_value_account_kind CHECK(kind IN ('gift_card','store_credit')),
 CONSTRAINT stored_value_account_status CHECK(status IN ('active','frozen','closed','expired')),
 CONSTRAINT stored_value_account_balance_nonnegative CHECK(balance_minor >= 0),
 CONSTRAINT stored_value_account_issued_nonnegative CHECK(issued_minor >= 0),
 CONSTRAINT stored_value_account_store_credit_customer CHECK(kind <> 'store_credit' OR customer_party_id IS NOT NULL),
 FOREIGN KEY(org_id,program_id) REFERENCES public.stored_value_programs(org_id,id),
 FOREIGN KEY(org_id,customer_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,liability_account_id) REFERENCES public.accounts(org_id,id)
);
ALTER TABLE public.stored_value_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stored_value_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.stored_value_accounts
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.stored_value_accounts IS 'openbooks:org_isolation:v1';
CREATE INDEX stored_value_accounts_program ON public.stored_value_accounts(org_id,program_id);
CREATE INDEX stored_value_accounts_customer ON public.stored_value_accounts(org_id,customer_party_id);

CREATE TABLE public.stored_value_entries (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 account_id uuid NOT NULL, kind text NOT NULL,
 amount_minor bigint NOT NULL, balance_after bigint NOT NULL,
 currency text NOT NULL, document_id uuid, document_line_id uuid,
 journal_entry_id uuid, idempotency_key text NOT NULL,
 reason text, actor_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id), UNIQUE(org_id,idempotency_key),
 CONSTRAINT stored_value_entry_kind CHECK(kind IN ('issue','redeem','adjust','expire','breakage','reversal')),
 FOREIGN KEY(org_id,account_id) REFERENCES public.stored_value_accounts(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,journal_entry_id) REFERENCES public.journal_entries(org_id,id)
);
ALTER TABLE public.stored_value_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stored_value_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.stored_value_entries
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.stored_value_entries IS 'openbooks:org_isolation:v1';
CREATE INDEX stored_value_entries_account ON public.stored_value_entries(org_id,account_id);

-- The entries table is the immutable stored-value ledger: corrections are
-- reversal entries, never edits or deletes of posted rows. The single
-- exception is scratch-org teardown, which marks its own transaction with
-- the teardown org GUC (set only by the test fixture teardown) and may
-- remove that org's rows.
CREATE FUNCTION public.stored_value_entries_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF current_setting('openbooks.teardown_org', true) = OLD.org_id::text THEN
  RETURN OLD;
 END IF;
 RAISE EXCEPTION 'Stored-value entries are immutable; record a reversal entry instead.' USING ERRCODE='23514';
 RETURN NULL;
END $func$;
CREATE TRIGGER stored_value_entries_immutable_trigger BEFORE UPDATE OR DELETE ON public.stored_value_entries FOR EACH ROW EXECUTE FUNCTION public.stored_value_entries_immutable();

insert into public.openbooks_query_catalog_relations (relation, added_in)
 values ('stored_value_programs', '0495_stored_value'),
        ('stored_value_accounts', '0495_stored_value'),
        ('stored_value_entries', '0495_stored_value')
 on conflict (relation) do nothing; -- expected on replay
select public.openbooks_refresh_query_catalog();
