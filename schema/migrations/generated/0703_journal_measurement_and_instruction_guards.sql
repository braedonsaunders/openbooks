-- Admit exact statistical measurements while monetary postings retain nonzero amounts.
-- Bind the book-currency local through an explicit instruction block label.
-- Backfill: none. Existing financial history and controlled clone admission remain unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);

CREATE OR REPLACE FUNCTION public.journal_instruction_line_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
<<instruction_line>>
DECLARE head journal_entries%ROWTYPE; chosen_calendar uuid; chosen_period uuid; v_book_currency text; reversal_line journal_lines%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.financial_history_native_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial history clone admission requires the exact registered source row, seed and destination parents.' USING ERRCODE='23514';
 END IF;
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
   v_book_currency:=public.accounting_book_currency(NEW.org_id,head.book_id,NEW.subsidiary_id);
   IF NEW.currency=instruction_line.v_book_currency OR NOT EXISTS(SELECT 1 FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
      WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id AND f.currency=NEW.currency) OR EXISTS(SELECT 1 FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
    WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id AND f.currency<>instruction_line.v_book_currency
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

CREATE FUNCTION public.journal_line_measurement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE account_type text;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.financial_history_native_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Financial history clone admission requires the exact registered source row, seed and destination parents.' USING ERRCODE='23514';
 END IF;
 SELECT a.type INTO account_type FROM accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.account_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Choose a posting account owned by the journal organization.' USING ERRCODE='23514';
 END IF;
 IF account_type='statistical' THEN
  IF NEW.amount<>0 OR NEW.txn_amount<>0 OR NEW.quantity IS NULL OR NEW.quantity=0 OR NEW.quantity<>trunc(NEW.quantity,4) OR
    coalesce(length(btrim(NEW.unit)),0)=0 OR NEW.is_open_item OR NEW.is_currency_adjustment THEN
   RAISE EXCEPTION 'Statistical accounts carry nonzero quantities with a unit and zero money.' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.amount=0 THEN
  RAISE EXCEPTION 'Zero-money journal lines require a statistical account with a nonzero quantity and unit.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_line_measurement_guard BEFORE INSERT OR UPDATE OF
 account_id,amount,txn_amount,quantity,unit,is_open_item,is_currency_adjustment ON public.journal_lines
FOR EACH ROW EXECUTE FUNCTION public.journal_line_measurement_guard();

-- Statistical document quantities are checked before the ledger's numeric coercion.
-- Header mode changes inspect the final transaction state, permitting atomic edits.
CREATE FUNCTION public.statistical_document_quantity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE statistical boolean;
BEGIN
 IF TG_TABLE_NAME='document_lines' THEN
  IF NEW.quantity<>trunc(NEW.quantity,4) THEN
   SELECT d.kind='journal' AND d.journal_mode='statistical' INTO statistical FROM documents d
    WHERE d.org_id=NEW.org_id AND d.id=NEW.document_id FOR SHARE;
   IF statistical THEN
    RAISE EXCEPTION 'Statistical quantities require at most four exact decimal places; finer quantities cannot be rounded into the ledger.' USING ERRCODE='23514';
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM documents d JOIN document_lines l ON l.org_id=d.org_id AND l.document_id=d.id
   WHERE d.org_id=NEW.org_id AND d.id=NEW.id AND d.kind='journal' AND d.journal_mode='statistical'
    AND l.quantity<>trunc(l.quantity,4)) THEN
  RAISE EXCEPTION 'Statistical quantities require at most four exact decimal places; correct the journal quantities before changing its mode.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER statistical_document_line_quantity_guard BEFORE INSERT OR UPDATE OF document_id,quantity
ON public.document_lines FOR EACH ROW EXECUTE FUNCTION public.statistical_document_quantity_guard();
CREATE CONSTRAINT TRIGGER statistical_document_header_quantity_guard AFTER INSERT OR UPDATE OF kind,journal_mode
ON public.documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.kind='journal' AND NEW.journal_mode='statistical')
EXECUTE FUNCTION public.statistical_document_quantity_guard();

ALTER TABLE public.journal_lines DROP CONSTRAINT jl_nonzero;
ALTER TABLE public.journal_lines ADD CONSTRAINT jl_nonzero CHECK (
 amount<>0 OR (txn_amount=0 AND quantity IS NOT NULL AND quantity<>0 AND quantity=trunc(quantity,4) AND coalesce(length(btrim(unit)),0)>0 AND NOT is_open_item AND NOT is_currency_adjustment)
);
