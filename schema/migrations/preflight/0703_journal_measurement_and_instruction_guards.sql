-- Pin both published prerequisites before extending statistical storage admission.
SELECT '0703.instruction_guard_definition' AS code,'refuse' AS severity,
 'public.journal_instruction_line_guard()' AS subject,
 'The instruction guard differs from its published prerequisite definition.' AS detail,
 'Preserve the controlled adjustment and registered clone protections; reconcile the exact prerequisite through the native runner before retrying.' AS remedy
 WHERE (SELECT prosrc FROM pg_proc WHERE oid='public.journal_instruction_line_guard()'::regprocedure) IS DISTINCT FROM $expected$
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
   IF NEW.currency=journal_instruction_line_guard.v_book_currency OR NOT EXISTS(SELECT 1 FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
      WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id AND f.currency=NEW.currency) OR EXISTS(SELECT 1 FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
    WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id AND f.currency<>journal_instruction_line_guard.v_book_currency
    GROUP BY f.currency HAVING sum(f.txn_amount)<>0) OR
    NEW.amount<>-(SELECT coalesce(sum(f.amount),0) FROM journal_lines f JOIN journal_entries e ON e.org_id=f.org_id AND e.id=f.entry_id
      WHERE f.org_id=NEW.org_id AND e.book_id=head.book_id AND e.status IN('posted','reversed') AND e.posting_date<=head.posting_date
      AND f.subsidiary_id=NEW.subsidiary_id AND f.account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'A currency adjustment clears the exact book residual only after every foreign currency balance is zero.' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $expected$
UNION ALL
SELECT '0703.nonzero_constraint_definition','refuse','public.journal_lines.jl_nonzero',
 'The monetary nonzero constraint differs from its published prerequisite definition.',
 'Preserve ledger history and reconcile the published constraint before enabling statistical measurements.'
 WHERE NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.journal_lines'::regclass
  AND conname='jl_nonzero' AND contype='c' AND convalidated
  AND pg_get_constraintdef(oid)='CHECK ((amount <> (0)::numeric))')
UNION ALL
SELECT '0703.measurement_guard_presence','refuse','public.journal_line_measurement_guard',
 'The forward measurement guard already exists without this migration identity.',
 'Preserve the existing objects and reconcile their complete published definitions and ledger identity before retrying.'
 WHERE to_regprocedure('public.journal_line_measurement_guard()') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.journal_lines'::regclass
    AND tgname='journal_line_measurement_guard')
UNION ALL
SELECT '0703.document_quantity_guard_presence','refuse','public.statistical_document_quantity_guard',
 'The forward statistical document guard already exists without this migration identity.',
 'Preserve the existing objects and reconcile their complete published definitions and ledger identity before retrying.'
 WHERE to_regprocedure('public.statistical_document_quantity_guard()') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE (tgrelid='public.document_lines'::regclass AND tgname='statistical_document_line_quantity_guard')
    OR (tgrelid='public.documents'::regclass AND tgname='statistical_document_header_quantity_guard'));
