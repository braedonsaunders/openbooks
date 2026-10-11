-- Native journal modes, approved future reversal instructions and per-line currency and entity-period evidence.
-- Backfill: none. New line evidence remains nullable on retained posted history.
-- Currency adjustments carry explicit zero transaction value and are excluded only from the rounding comparison.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.documents ADD COLUMN journal_mode text NOT NULL DEFAULT 'monetary' CHECK(journal_mode IN('monetary','statistical','currency_adjustment')),
 ADD COLUMN journal_reverse_on date, ADD COLUMN journal_fx_rate_explicit boolean NOT NULL DEFAULT false;
ALTER TABLE public.document_lines ADD COLUMN journal_currency text REFERENCES public.currencies(code),
 ADD COLUMN journal_fx_rate numeric(19,10) CHECK(journal_fx_rate>0), ADD COLUMN journal_eliminate boolean NOT NULL DEFAULT false;
ALTER TABLE public.journal_lines ADD COLUMN period_id uuid, ADD COLUMN eliminate boolean NOT NULL DEFAULT false,
 ADD COLUMN is_currency_adjustment boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT journal_lines_entity_period_fkey FOREIGN KEY(org_id,period_id) REFERENCES public.accounting_periods(org_id,id);
ALTER TABLE public.journal_lines DROP CONSTRAINT jl_fx_consistent;
ALTER TABLE public.journal_lines ADD CONSTRAINT jl_fx_consistent CHECK(
 (is_currency_adjustment AND txn_amount=0) OR (NOT is_currency_adjustment AND abs(amount-round(txn_amount*fx_rate,4))<=0.005));
CREATE OR REPLACE FUNCTION public.je_check_posted_balance() RETURNS trigger LANGUAGE plpgsql AS $$ 
declare
  v_sum numeric(19,4);
  v_bad record;
  v_fx record;
begin
  if new.status <> 'posted' then return null; end if;
  select coalesce(sum(amount), 0) into v_sum
    from journal_lines
   where entry_id = new.id and org_id = new.org_id;
  if v_sum <> 0 then
    raise exception 'posted journal entry % does not balance (sum = %)', new.id, v_sum
      using errcode = '23514';
  end if;
  select subsidiary_id, sum(amount) as total into v_bad
    from journal_lines
   where entry_id = new.id and org_id = new.org_id
   group by subsidiary_id having sum(amount) <> 0 limit 1;
  if found then
    raise exception 'posted journal entry % does not balance for subsidiary % (sum = %)',
      new.id, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
  end if;
  select subsidiary_id,
         sum(case when is_currency_adjustment then 0 else abs(amount - round(txn_amount * fx_rate, 4)) end) as deviation,
         count(*) as lines,
         count(*) * 0.00005 as bound into v_fx
    from journal_lines
   where entry_id = new.id and org_id = new.org_id
   group by subsidiary_id
  having sum(case when is_currency_adjustment then 0 else abs(amount - round(txn_amount * fx_rate, 4)) end) > count(*) * 0.00005 limit 1;
  -- This gate fires when an entry becomes posted: inserted posted, or a
  -- draft flipped to posted. Either way nothing has been posted yet.
  if found then
    raise exception 'posted journal entry % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): nothing was posted; correct the line exchange rates or functional amounts so each amount is its transaction amount times its rate, then post again',
      new.id, v_fx.subsidiary_id, v_fx.deviation, v_fx.lines, v_fx.bound using errcode = '23514';
  end if;
  if (select count(*) from journal_lines where entry_id = new.id and org_id = new.org_id) < 2
     and not exists(select 1 from journal_lines l join accounts a on a.org_id=l.org_id and a.id=l.account_id where l.org_id=new.org_id and l.entry_id=new.id and a.type='statistical' and l.quantity<>0 and length(btrim(l.unit))>0) then
    raise exception 'posted journal entry % must contain at least two lines', new.id
      using errcode = '23514';
  end if;
  return null;
end  $$;
CREATE OR REPLACE FUNCTION public.journal_lines_check_fx_residual_entries(p_entry_ids uuid[]) RETURNS void LANGUAGE plpgsql AS $$ 
declare
  v_bad_org uuid;
  v_bad_entry uuid;
  v_bad_subsidiary uuid;
  v_bad_deviation numeric(19, 4);
  v_bad_lines integer;
  v_bad_bound numeric;
begin
  -- One re-sum per touched (org, entry, subsidiary) group, not per line.
  -- Drafts are skipped: they post through je_check_posted_balance below.
  select l.org_id, l.entry_id, l.subsidiary_id,
         sum(case when l.is_currency_adjustment then 0 else abs(l.amount - round(l.txn_amount * l.fx_rate, 4)) end),
         count(*), count(*) * 0.00005
    into v_bad_org, v_bad_entry, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
   where e.status is distinct from 'draft'
   group by l.org_id, l.entry_id, l.subsidiary_id
  having sum(case when l.is_currency_adjustment then 0 else abs(l.amount - round(l.txn_amount * l.fx_rate, 4)) end) > count(*) * 0.00005
   limit 1;
  if found then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): correct through the ledger API by posting a reversal and reposting instead of editing history',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  end if;
end  $$;
CREATE TABLE public.journal_reversal_instructions(
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 document_id uuid NOT NULL,source_entry_id uuid NOT NULL,reverse_on date NOT NULL,
 status text NOT NULL DEFAULT 'planned' CHECK(status IN('planned','completed','cancelled','blocked')),
 reversal_entry_id uuid,last_error text,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid,
 UNIQUE(org_id,id),UNIQUE(org_id,source_entry_id),
 FOREIGN KEY(org_id,document_id) REFERENCES public.documents(org_id,id),
 FOREIGN KEY(org_id,source_entry_id) REFERENCES public.journal_entries(org_id,id),
 FOREIGN KEY(org_id,reversal_entry_id) REFERENCES public.journal_entries(org_id,id));
ALTER TABLE public.journal_reversal_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_reversal_instructions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.journal_reversal_instructions
 USING(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.journal_reversal_instructions IS 'openbooks:org_isolation:v1';
CREATE INDEX journal_reversal_instructions_due ON public.journal_reversal_instructions(org_id,reverse_on) WHERE status IN('planned','blocked');
CREATE FUNCTION public.journal_instruction_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE head journal_entries%ROWTYPE; chosen_calendar uuid; chosen_period uuid; currency text; reversal_line journal_lines%ROWTYPE;
BEGIN
 SELECT * INTO STRICT head FROM journal_entries WHERE org_id=NEW.org_id AND id=NEW.entry_id;
 IF public.connector_historical_replay_authorized(NEW.org_id) THEN
  NEW.period_id:=head.period_id;
 ELSE
 chosen_calendar:=public.subsidiary_posting_calendar(NEW.org_id,NEW.subsidiary_id,head.posting_date);
 SELECT id INTO chosen_period FROM accounting_periods WHERE org_id=NEW.org_id AND id=head.period_id AND fiscal_calendar_id=chosen_calendar;
 IF chosen_period IS NULL THEN SELECT id INTO chosen_period FROM accounting_periods WHERE org_id=NEW.org_id AND fiscal_calendar_id=chosen_calendar
  AND NOT is_adjustment AND starts_on<=head.posting_date AND ends_on>=head.posting_date ORDER BY starts_on,ends_on,id LIMIT 1; END IF;
 IF chosen_period IS NULL THEN RAISE EXCEPTION 'Generate the entity accounting period covering this posting date.' USING ERRCODE='23514'; END IF;
 IF NEW.period_id IS NOT NULL AND NEW.period_id<>chosen_period THEN RAISE EXCEPTION 'A journal line must use its entity accounting period.' USING ERRCODE='23514'; END IF;
 NEW.period_id:=chosen_period;
 END IF;
 IF EXISTS(SELECT 1 FROM accounts WHERE org_id=NEW.org_id AND id=NEW.account_id AND type='statistical') THEN
  IF NEW.amount<>0 OR NEW.txn_amount<>0 OR NEW.quantity IS NULL OR NEW.quantity=0 OR coalesce(length(btrim(NEW.unit)),0)=0 OR NEW.is_open_item OR NEW.is_currency_adjustment THEN
   RAISE EXCEPTION 'Statistical accounts carry nonzero quantities with a unit and zero money.' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.is_currency_adjustment THEN
  IF NEW.txn_amount<>0 OR NEW.amount=0 OR NEW.is_open_item OR head.origin<>'currency_adjustment' THEN
   RAISE EXCEPTION 'Typed currency adjustments carry only a base amount and zero foreign transaction value.' USING ERRCODE='23514'; END IF;
  IF head.reverses_entry_id IS NOT NULL THEN
   SELECT * INTO reversal_line FROM journal_lines WHERE org_id=NEW.org_id AND entry_id=head.reverses_entry_id AND line_number=NEW.line_number;
   IF NOT FOUND OR NOT reversal_line.is_currency_adjustment OR reversal_line.account_id<>NEW.account_id OR reversal_line.subsidiary_id<>NEW.subsidiary_id OR reversal_line.amount<>-NEW.amount OR reversal_line.currency<>NEW.currency OR reversal_line.fx_rate<>NEW.fx_rate OR reversal_line.txn_amount<>-NEW.txn_amount THEN
    RAISE EXCEPTION 'A currency adjustment reversal must mirror its original recorded line.' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM documents WHERE org_id=NEW.org_id AND id=head.source_document_id AND kind='journal' AND journal_mode='currency_adjustment') THEN
   RAISE EXCEPTION 'A currency adjustment requires its native governed journal instruction.' USING ERRCODE='23514';
  END IF;
  IF head.reverses_entry_id IS NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:' || NEW.org_id::text,0));
   currency:=public.accounting_book_currency(NEW.org_id,head.book_id,NEW.subsidiary_id);
   IF NEW.currency=currency OR NOT EXISTS(SELECT 1 FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
      WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id AND f.currency=NEW.currency) OR EXISTS(SELECT 1 FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
    WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id AND f.currency<>currency
    GROUP BY f.currency HAVING sum(f.txn_amount)<>0) OR
    NEW.amount<>-(SELECT coalesce(sum(f.amount),0) FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
      WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'A currency adjustment clears the exact book residual only after every foreign currency balance is zero.' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_instruction_line_guard BEFORE INSERT ON public.journal_lines FOR EACH ROW EXECUTE FUNCTION public.journal_instruction_line_guard();
CREATE FUNCTION public.journal_entity_period_post_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE leg record; source_module text;
BEGIN
 IF NEW.status<>'posted' OR OLD.status='posted' THEN RETURN NEW; END IF;
 SELECT public.document_close_module(kind) INTO source_module FROM documents WHERE org_id=NEW.org_id AND id=NEW.source_document_id;
 FOR leg IN SELECT DISTINCT subsidiary_id,coalesce(period_id,NEW.period_id) as period_id FROM journal_lines WHERE org_id=NEW.org_id AND entry_id=NEW.id LOOP
  PERFORM period_posting_fence(NEW.org_id,leg.period_id,NEW.book_id);
  IF period_module_blocks_write(NEW.org_id,leg.period_id,NEW.book_id,leg.subsidiary_id,'gl',public.connector_historical_replay_authorized(NEW.org_id))
   OR (source_module IS NOT NULL AND source_module<>'gl' AND period_module_blocks_write(NEW.org_id,leg.period_id,NEW.book_id,leg.subsidiary_id,source_module,public.connector_historical_replay_authorized(NEW.org_id))) THEN
   RAISE EXCEPTION 'The entity accounting period is closed for this posting module.' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_entity_period_post_guard BEFORE UPDATE OF status ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.journal_entity_period_post_guard();
CREATE FUNCTION public.journal_reversal_instruction_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Scheduled reversal instructions are retained history.' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['status','reversal_entry_id','last_error','updated_at','updated_by']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','reversal_entry_id','last_error','updated_at','updated_by']) OR OLD.status IN('completed','cancelled')) THEN
  RAISE EXCEPTION 'An approved reversal instruction retains its source, actor and date; only its execution state can advance.' USING ERRCODE='23514'; END IF;
 IF NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM journal_entries WHERE org_id=NEW.org_id AND id=NEW.reversal_entry_id
   AND status='posted' AND reverses_entry_id=NEW.source_entry_id AND posting_date=NEW.reverse_on) THEN
  RAISE EXCEPTION 'Completion identifies the exact posted reversal of the approved instruction.' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM documents d JOIN journal_entries e ON e.org_id=d.org_id AND e.source_document_id=d.id
  WHERE d.org_id=NEW.org_id AND d.id=NEW.document_id AND e.id=NEW.source_entry_id AND d.kind='journal' AND d.journal_reverse_on=NEW.reverse_on AND NEW.reverse_on>e.posting_date) THEN
  RAISE EXCEPTION 'A scheduled reversal must match its posted journal instruction.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_reversal_instruction_guard BEFORE INSERT OR UPDATE OR DELETE ON public.journal_reversal_instructions FOR EACH ROW EXECUTE FUNCTION public.journal_reversal_instruction_guard();
INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES('journal_reversal_instructions','0692_journal_instruction_modes');
SELECT public.openbooks_refresh_query_catalog();

-- Existing custom slugs are retained; installing an already named report is a benign conflict.
INSERT INTO public.report_definitions(org_id,kind,slug,name,description,report_type,statement,system)
 SELECT id,'built_in','statistical-journal','Statistical Journal','Exact non-monetary quantities by account, unit and legal entity.','statement','{"kind":"statistical-journal"}'::jsonb,true FROM public.orgs
 ON CONFLICT(org_id,slug) DO NOTHING;

CREATE FUNCTION public.journal_instruction_financial_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF OLD.status<>'draft' AND (NEW.journal_mode IS DISTINCT FROM OLD.journal_mode OR NEW.journal_reverse_on IS DISTINCT FROM OLD.journal_reverse_on
   OR NEW.journal_fx_rate_explicit IS DISTINCT FROM OLD.journal_fx_rate_explicit) THEN
  RAISE EXCEPTION 'Approved journal mode, stated-rate intent and reversal date are immutable. Withdraw a pending submission or create a separate correcting journal.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_instruction_financial_guard BEFORE UPDATE OF journal_mode,journal_reverse_on,journal_fx_rate_explicit ON public.documents
 FOR EACH ROW EXECUTE FUNCTION public.journal_instruction_financial_guard();
