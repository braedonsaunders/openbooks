-- OpenBooks forward migration 0685_intercompany_representing_parties_and_netting.
--
-- Representing parties: an operating subsidiary may be represented to its
-- sister entities by one customer and one vendor. A document whose party
-- represents another subsidiary is intercompany, and its receivable or
-- payable posts to the intercompany receivable or payable account configured
-- on the intercompany pair, which consolidation eliminates. The guard refuses
-- a representing party that already transacts with the subsidiary it
-- represents, an inactive party role, and an inactive or elimination entity.
--
-- Intercompany pairs gain optional intercompany receivable and payable
-- accounts for each side. The pair guard requires each to be an active,
-- eliminated receivable or payable posting account.
--
-- Netting runs settle open intercompany balances as of a date for a set of
-- subsidiaries. A run stores its proposal (fingerprinted computation), its
-- approval and its posting; its lines record every open item, due-to/due-from
-- position and bank movement the run settles. A run's terms never change
-- after proposal and its lifecycle moves only forward. Fund transfers record
-- governed bank movements between two entities' bank accounts and admit only
-- the reversal transition after posting.
--
-- Backfill: none. The new tables start empty and the new pair columns are
-- nullable, so existing pairs keep their behavior.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Intercompany pairs: composite tenant key for child references and the
-- intercompany receivable/payable accounts of each side.
CREATE UNIQUE INDEX IF NOT EXISTS intercompany_pairs_org_id_id_unique
  ON public.intercompany_pairs (org_id, id);

ALTER TABLE public.intercompany_pairs
  ADD COLUMN IF NOT EXISTS from_receivable_account_id uuid,
  ADD COLUMN IF NOT EXISTS from_payable_account_id uuid,
  ADD COLUMN IF NOT EXISTS to_receivable_account_id uuid,
  ADD COLUMN IF NOT EXISTS to_payable_account_id uuid;

ALTER TABLE public.intercompany_pairs
  ADD CONSTRAINT intercompany_pairs_from_receivable_fk
    FOREIGN KEY (org_id, from_receivable_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  ADD CONSTRAINT intercompany_pairs_from_payable_fk
    FOREIGN KEY (org_id, from_payable_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  ADD CONSTRAINT intercompany_pairs_to_receivable_fk
    FOREIGN KEY (org_id, to_receivable_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  ADD CONSTRAINT intercompany_pairs_to_payable_fk
    FOREIGN KEY (org_id, to_payable_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE;

COMMENT ON COLUMN public.intercompany_pairs.from_receivable_account_id IS
  'Receivable control account the from-side entity posts intercompany invoices and credits to; must be an eliminated asset_receivable account.';
COMMENT ON COLUMN public.intercompany_pairs.from_payable_account_id IS
  'Payable control account the from-side entity posts intercompany bills and vendor credits to; must be an eliminated liability_payable account.';
COMMENT ON COLUMN public.intercompany_pairs.to_receivable_account_id IS
  'Receivable control account the to-side entity posts intercompany invoices and credits to; must be an eliminated asset_receivable account.';
COMMENT ON COLUMN public.intercompany_pairs.to_payable_account_id IS
  'Payable control account the to-side entity posts intercompany bills and vendor credits to; must be an eliminated liability_payable account.';

CREATE OR REPLACE FUNCTION public.intercompany_pair_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_from_type text;
  v_to_type text;
  v_control record;
begin
  if new.from_subsidiary_id = new.to_subsidiary_id then
    raise exception 'intercompany subsidiaries must be different' using errcode = '23514';
  end if;
  if (select count(*) from subsidiaries s
       where s.org_id = new.org_id and s.id in (new.from_subsidiary_id, new.to_subsidiary_id)
         and s.is_active and not s.is_elimination) <> 2 then
    raise exception 'intercompany subsidiaries are invalid' using errcode = '23514';
  end if;
  select type into v_from_type from accounts
   where id = new.due_from_account_id and org_id = new.org_id
     and is_active and not is_summary and eliminate;
  select type into v_to_type from accounts
   where id = new.due_to_account_id and org_id = new.org_id
     and is_active and not is_summary and eliminate;
  if v_from_type is null or v_from_type not like 'asset\_%' escape '\' then
    raise exception 'due-from account must be an eliminable asset' using errcode = '23514';
  end if;
  if v_to_type is null or v_to_type not like 'liability\_%' escape '\' then
    raise exception 'due-to account must be an eliminable liability' using errcode = '23514';
  end if;
  -- Intercompany receivable and payable control accounts are optional; when
  -- set they must be eliminated posting accounts of the control type.
  for v_control in
    select account_id, expected, label from (values
      (new.from_receivable_account_id, 'asset_receivable', 'from-side intercompany receivable'),
      (new.to_receivable_account_id, 'asset_receivable', 'to-side intercompany receivable'),
      (new.from_payable_account_id, 'liability_payable', 'from-side intercompany payable'),
      (new.to_payable_account_id, 'liability_payable', 'to-side intercompany payable')
    ) as controls(account_id, expected, label)
    where account_id is not null
  loop
    if not exists (
      select 1 from accounts a
       where a.org_id = new.org_id and a.id = v_control.account_id
         and a.is_active and not a.is_summary and a.eliminate and a.type = v_control.expected
    ) then
      raise exception '% account must be an active eliminated % account', v_control.label, v_control.expected
        using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

-- Representing parties --------------------------------------------------------

CREATE TABLE public.intercompany_representing_parties (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  customer_party_id uuid,
  vendor_party_id uuid,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT intercompany_representing_parties_pkey PRIMARY KEY (id),
  CONSTRAINT intercompany_representing_parties_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT intercompany_representing_parties_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT intercompany_representing_parties_subsidiary_fk
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_representing_parties_customer_fk
    FOREIGN KEY (org_id, customer_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_representing_parties_vendor_fk
    FOREIGN KEY (org_id, vendor_party_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_representing_parties_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT intercompany_representing_parties_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT intercompany_representing_parties_some_party
    CHECK (customer_party_id IS NOT NULL OR vendor_party_id IS NOT NULL)
);

CREATE UNIQUE INDEX intercompany_representing_parties_one_per_subsidiary
  ON public.intercompany_representing_parties (org_id, subsidiary_id) WHERE is_active;
CREATE UNIQUE INDEX intercompany_representing_parties_one_customer
  ON public.intercompany_representing_parties (org_id, customer_party_id)
  WHERE is_active AND customer_party_id IS NOT NULL;
CREATE UNIQUE INDEX intercompany_representing_parties_one_vendor
  ON public.intercompany_representing_parties (org_id, vendor_party_id)
  WHERE is_active AND vendor_party_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.intercompany_representing_party_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  v_root uuid;
  v_role record;
BEGIN
  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  IF NOT NEW.is_active THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.subsidiaries s
     WHERE s.org_id = NEW.org_id AND s.id = NEW.subsidiary_id AND s.is_active AND NOT s.is_elimination
  ) THEN
    RAISE EXCEPTION 'a representing party must represent an active operating subsidiary' USING errcode = '23514';
  END IF;
  SELECT s.id INTO v_root FROM public.subsidiaries s WHERE s.org_id = NEW.org_id AND s.parent_id IS NULL;
  FOR v_role IN
    SELECT party_id, role FROM (VALUES (NEW.customer_party_id, 'customer'), (NEW.vendor_party_id, 'vendor')) AS r(party_id, role)
     WHERE party_id IS NOT NULL
  LOOP
    IF v_role.role = 'customer' AND NOT EXISTS (
      SELECT 1 FROM public.customer_roles r JOIN public.parties p ON p.org_id = r.org_id AND p.id = r.party_id
       WHERE r.org_id = NEW.org_id AND r.party_id = v_role.party_id AND r.is_active AND p.is_active
    ) THEN
      RAISE EXCEPTION 'the representing customer must be an active customer' USING errcode = '23514';
    END IF;
    IF v_role.role = 'vendor' AND NOT EXISTS (
      SELECT 1 FROM public.vendor_roles r JOIN public.parties p ON p.org_id = r.org_id AND p.id = r.party_id
       WHERE r.org_id = NEW.org_id AND r.party_id = v_role.party_id AND r.is_active AND p.is_active
    ) THEN
      RAISE EXCEPTION 'the representing vendor must be an active vendor' USING errcode = '23514';
    END IF;
    -- A subsidiary cannot trade with itself: the representing party must not
    -- transact with the entity it represents.
    IF EXISTS (
      SELECT 1 FROM public.parties p
       WHERE p.org_id = NEW.org_id AND p.id = v_role.party_id
         AND coalesce(p.subsidiary_id, v_root) = NEW.subsidiary_id
    ) OR EXISTS (
      SELECT 1 FROM public.party_subsidiaries ps
       WHERE ps.org_id = NEW.org_id AND ps.party_id = v_role.party_id AND ps.subsidiary_id = NEW.subsidiary_id
    ) THEN
      RAISE EXCEPTION 'the representing % transacts with the subsidiary it represents; a subsidiary cannot be its own customer or vendor', v_role.role
        USING errcode = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER intercompany_representing_party_guard
  BEFORE INSERT OR UPDATE ON public.intercompany_representing_parties
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_representing_party_guard();

ALTER TABLE public.intercompany_representing_parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercompany_representing_parties FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.intercompany_representing_parties
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.intercompany_representing_parties IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.intercompany_representing_parties IS
  'The customer and vendor that represent an operating subsidiary to its sister entities; documents with these parties post through intercompany control accounts.';

-- Netting runs ----------------------------------------------------------------

CREATE TABLE public.intercompany_netting_runs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  run_number text NOT NULL,
  as_of_date date NOT NULL,
  book_id uuid NOT NULL,
  period_id uuid NOT NULL,
  subsidiary_ids uuid[] NOT NULL,
  settle_cash boolean DEFAULT false NOT NULL,
  bank_accounts jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'proposed' NOT NULL,
  computation jsonb NOT NULL,
  fingerprint text NOT NULL,
  reason text NOT NULL,
  idempotency_key text,
  flow_run_id uuid,
  decision_note text,
  proposed_by uuid NOT NULL,
  proposed_at timestamp with time zone DEFAULT now() NOT NULL,
  submitted_by uuid,
  submitted_at timestamp with time zone,
  decided_by uuid,
  decided_at timestamp with time zone,
  posted_by uuid,
  posted_at timestamp with time zone,
  cancelled_by uuid,
  cancelled_at timestamp with time zone,
  cancel_reason text,
  reversed_by uuid,
  reversed_at timestamp with time zone,
  reversal_date date,
  reverse_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT intercompany_netting_runs_pkey PRIMARY KEY (id),
  CONSTRAINT intercompany_netting_runs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT intercompany_netting_runs_number_unique UNIQUE (org_id, run_number),
  CONSTRAINT intercompany_netting_runs_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT intercompany_netting_runs_book_fk
    FOREIGN KEY (org_id, book_id) REFERENCES public.accounting_books(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_runs_period_fk
    FOREIGN KEY (org_id, period_id) REFERENCES public.accounting_periods(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_runs_proposed_by_fk
    FOREIGN KEY (org_id, proposed_by) REFERENCES public.users(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_runs_status
    CHECK (status IN ('proposed', 'pending_approval', 'approved', 'rejected', 'posted', 'cancelled', 'reversed')),
  CONSTRAINT intercompany_netting_runs_scope CHECK (cardinality(subsidiary_ids) >= 2),
  CONSTRAINT intercompany_netting_runs_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT intercompany_netting_runs_computation CHECK (jsonb_typeof(computation) = 'object'),
  CONSTRAINT intercompany_netting_runs_bank_accounts CHECK (jsonb_typeof(bank_accounts) = 'object'),
  CONSTRAINT intercompany_netting_runs_fingerprint CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT intercompany_netting_runs_posted_evidence
    CHECK (status NOT IN ('posted', 'reversed') OR (posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CONSTRAINT intercompany_netting_runs_cancel_evidence
    CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND length(btrim(coalesce(cancel_reason, ''))) > 0)),
  CONSTRAINT intercompany_netting_runs_reverse_evidence
    CHECK (status <> 'reversed' OR (reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reversal_date IS NOT NULL
      AND length(btrim(coalesce(reverse_reason, ''))) > 0))
);

CREATE UNIQUE INDEX intercompany_netting_runs_idempotency
  ON public.intercompany_netting_runs (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX intercompany_netting_runs_status
  ON public.intercompany_netting_runs (org_id, status, as_of_date);

CREATE TABLE public.intercompany_netting_lines (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  line_number integer NOT NULL,
  pair_id uuid NOT NULL,
  currency text NOT NULL,
  subsidiary_id uuid NOT NULL,
  counterparty_subsidiary_id uuid NOT NULL,
  component text NOT NULL,
  account_id uuid NOT NULL,
  journal_line_id uuid,
  document_id uuid,
  functional_currency text NOT NULL,
  open_transaction_amount numeric(19,4) DEFAULT 0 NOT NULL,
  open_carrying_amount numeric(19,4) DEFAULT 0 NOT NULL,
  netted_amount numeric(19,4) DEFAULT 0 NOT NULL,
  cash_amount numeric(19,4) DEFAULT 0 NOT NULL,
  settlement_rate numeric(19,10) NOT NULL,
  realized_fx numeric(19,4) DEFAULT 0 NOT NULL,
  settlement_entry_id uuid,
  settlement_line_id uuid,
  application_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT intercompany_netting_lines_pkey PRIMARY KEY (id),
  CONSTRAINT intercompany_netting_lines_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT intercompany_netting_lines_number_unique UNIQUE (org_id, run_id, line_number),
  CONSTRAINT intercompany_netting_lines_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_run_fk
    FOREIGN KEY (org_id, run_id) REFERENCES public.intercompany_netting_runs(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_pair_fk
    FOREIGN KEY (org_id, pair_id) REFERENCES public.intercompany_pairs(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_subsidiary_fk
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_counterparty_fk
    FOREIGN KEY (org_id, counterparty_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_journal_line_fk
    FOREIGN KEY (org_id, journal_line_id) REFERENCES public.journal_lines(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_document_fk
    FOREIGN KEY (org_id, document_id) REFERENCES public.documents(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_settlement_entry_fk
    FOREIGN KEY (org_id, settlement_entry_id) REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_settlement_line_fk
    FOREIGN KEY (org_id, settlement_line_id) REFERENCES public.journal_lines(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_application_fk
    FOREIGN KEY (application_id) REFERENCES public.applications(id) DEFERRABLE,
  CONSTRAINT intercompany_netting_lines_component
    CHECK (component IN ('open_item', 'due_position', 'cash')),
  CONSTRAINT intercompany_netting_lines_component_source
    CHECK ((component = 'open_item') = (journal_line_id IS NOT NULL)),
  CONSTRAINT intercompany_netting_lines_entities CHECK (subsidiary_id <> counterparty_subsidiary_id),
  CONSTRAINT intercompany_netting_lines_currency CHECK (currency ~ '^[A-Z]{3}$' AND functional_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT intercompany_netting_lines_rate CHECK (settlement_rate > 0),
  CONSTRAINT intercompany_netting_lines_line_number CHECK (line_number > 0)
);

CREATE INDEX intercompany_netting_lines_run
  ON public.intercompany_netting_lines (org_id, run_id, line_number);
CREATE INDEX intercompany_netting_lines_journal_line
  ON public.intercompany_netting_lines (org_id, journal_line_id) WHERE journal_line_id IS NOT NULL;

-- A run's terms are fixed at proposal and its lifecycle only moves forward.
-- Lines are written with their proposal and receive their settlement
-- evidence once, when the run posts.
CREATE OR REPLACE FUNCTION public.intercompany_netting_run_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
       OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'intercompany netting runs are retained; cancel a proposal or reverse a posted run instead';
  END IF;
  IF (NEW.org_id, NEW.run_number, NEW.as_of_date, NEW.book_id, NEW.period_id, NEW.subsidiary_ids,
      NEW.settle_cash, NEW.bank_accounts, NEW.computation, NEW.fingerprint, NEW.reason,
      NEW.idempotency_key, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.org_id, OLD.run_number, OLD.as_of_date, OLD.book_id, OLD.period_id, OLD.subsidiary_ids,
      OLD.settle_cash, OLD.bank_accounts, OLD.computation, OLD.fingerprint, OLD.reason,
      OLD.idempotency_key, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'an intercompany netting run keeps the terms it was proposed with; cancel it and propose a new run';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'proposed' AND NEW.status IN ('pending_approval', 'approved', 'cancelled'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('posted', 'cancelled'))
    OR (OLD.status = 'posted' AND NEW.status = 'reversed')
  ) THEN
    RAISE EXCEPTION 'an intercompany netting run cannot move from % to %', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('posted', 'reversed', 'cancelled', 'rejected') AND NEW.status = OLD.status
     AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'a % intercompany netting run is closed history', OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER intercompany_netting_run_guard
  BEFORE UPDATE OR DELETE ON public.intercompany_netting_runs
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_netting_run_guard();

CREATE OR REPLACE FUNCTION public.intercompany_netting_line_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
       OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'intercompany netting lines are retained with their run';
  END IF;
  SELECT r.status INTO v_status FROM public.intercompany_netting_runs r
   WHERE r.org_id = NEW.org_id AND r.id = NEW.run_id;
  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'proposed' THEN
      RAISE EXCEPTION 'intercompany netting lines are written with the run proposal';
    END IF;
    RETURN NEW;
  END IF;
  -- Settlement evidence is stamped once, while the run posts.
  IF to_jsonb(NEW) - 'settlement_entry_id' - 'settlement_line_id' - 'application_id'
     IS DISTINCT FROM to_jsonb(OLD) - 'settlement_entry_id' - 'settlement_line_id' - 'application_id'
     OR (OLD.settlement_entry_id IS NOT NULL AND NEW.settlement_entry_id IS DISTINCT FROM OLD.settlement_entry_id)
     OR (OLD.settlement_line_id IS NOT NULL AND NEW.settlement_line_id IS DISTINCT FROM OLD.settlement_line_id)
     OR (OLD.application_id IS NOT NULL AND NEW.application_id IS DISTINCT FROM OLD.application_id)
     OR v_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'intercompany netting lines are immutable; settlement evidence is recorded once when the run posts';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER intercompany_netting_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.intercompany_netting_lines
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_netting_line_guard();

ALTER TABLE public.intercompany_netting_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercompany_netting_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.intercompany_netting_runs
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.intercompany_netting_runs IS 'openbooks:org_isolation:v1';

ALTER TABLE public.intercompany_netting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercompany_netting_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.intercompany_netting_lines
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.intercompany_netting_lines IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.intercompany_netting_runs IS
  'Governed netting and settlement of open intercompany balances as of a date; the proposal is fingerprinted and posts unchanged.';
COMMENT ON TABLE public.intercompany_netting_lines IS
  'Each open item, due-to/due-from position and bank movement a netting run settles, with its rate and realized exchange difference.';

-- Fund transfers between entities ---------------------------------------------

CREATE TABLE public.intercompany_fund_transfers (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  transfer_number text NOT NULL,
  transfer_date date NOT NULL,
  from_subsidiary_id uuid NOT NULL,
  to_subsidiary_id uuid NOT NULL,
  from_bank_account_id uuid NOT NULL,
  to_bank_account_id uuid NOT NULL,
  currency text NOT NULL,
  amount numeric(19,4) NOT NULL,
  memo text,
  reason text NOT NULL,
  entry_id uuid NOT NULL,
  status text DEFAULT 'posted' NOT NULL,
  idempotency_key text,
  reversal_entry_id uuid,
  reversal_date date,
  reverse_reason text,
  reversed_by uuid,
  reversed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT intercompany_fund_transfers_pkey PRIMARY KEY (id),
  CONSTRAINT intercompany_fund_transfers_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT intercompany_fund_transfers_number_unique UNIQUE (org_id, transfer_number),
  CONSTRAINT intercompany_fund_transfers_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT intercompany_fund_transfers_from_subsidiary_fk
    FOREIGN KEY (org_id, from_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fund_transfers_to_subsidiary_fk
    FOREIGN KEY (org_id, to_subsidiary_id) REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fund_transfers_from_bank_fk
    FOREIGN KEY (org_id, from_bank_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fund_transfers_to_bank_fk
    FOREIGN KEY (org_id, to_bank_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fund_transfers_entry_fk
    FOREIGN KEY (org_id, entry_id) REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fund_transfers_reversal_entry_fk
    FOREIGN KEY (org_id, reversal_entry_id) REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fund_transfers_created_by_fk
    FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id) DEFERRABLE,
  CONSTRAINT intercompany_fund_transfers_entities CHECK (from_subsidiary_id <> to_subsidiary_id),
  CONSTRAINT intercompany_fund_transfers_accounts CHECK (from_bank_account_id <> to_bank_account_id),
  CONSTRAINT intercompany_fund_transfers_amount CHECK (amount > 0),
  CONSTRAINT intercompany_fund_transfers_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT intercompany_fund_transfers_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT intercompany_fund_transfers_status CHECK (status IN ('posted', 'reversed')),
  CONSTRAINT intercompany_fund_transfers_reverse_evidence
    CHECK ((status = 'reversed') = (reversal_entry_id IS NOT NULL AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL
      AND reversal_date IS NOT NULL AND length(btrim(coalesce(reverse_reason, ''))) > 0))
);

CREATE UNIQUE INDEX intercompany_fund_transfers_idempotency
  ON public.intercompany_fund_transfers (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX intercompany_fund_transfers_date
  ON public.intercompany_fund_transfers (org_id, transfer_date);

CREATE OR REPLACE FUNCTION public.intercompany_fund_transfer_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
       OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'intercompany fund transfers are retained; reverse a transfer instead';
  END IF;
  IF NOT (OLD.status = 'posted' AND NEW.status = 'reversed')
     OR to_jsonb(NEW) - 'status' - 'reversal_entry_id' - 'reversal_date' - 'reverse_reason' - 'reversed_by' - 'reversed_at' - 'updated_at'
        IS DISTINCT FROM
        to_jsonb(OLD) - 'status' - 'reversal_entry_id' - 'reversal_date' - 'reverse_reason' - 'reversed_by' - 'reversed_at' - 'updated_at' THEN
    RAISE EXCEPTION 'a posted intercompany fund transfer changes only by reversal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER intercompany_fund_transfer_guard
  BEFORE UPDATE OR DELETE ON public.intercompany_fund_transfers
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_fund_transfer_guard();

ALTER TABLE public.intercompany_fund_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intercompany_fund_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.intercompany_fund_transfers
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.intercompany_fund_transfers IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.intercompany_fund_transfers IS
  'Bank transfers between two entities'' bank accounts, posted with due-to/due-from legs so each entity balances on its own.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
  ('intercompany_representing_parties', '0685_intercompany_representing_parties_and_netting'),
  ('intercompany_netting_runs', '0685_intercompany_representing_parties_and_netting'),
  ('intercompany_netting_lines', '0685_intercompany_representing_parties_and_netting'),
  ('intercompany_fund_transfers', '0685_intercompany_representing_parties_and_netting')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
