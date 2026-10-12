-- Preserve both published overloads before extending controlled residual evidence.
SELECT '0700.guard_definition' AS code,'refuse' AS severity,'public.journal_lines_check_fx_residual_entries(uuid[])' AS subject,
 'The authoritative FX guard differs from its published prerequisite definition.' AS detail,
 'Preserve the existing function and reconcile the exact published prerequisite through the native runner before retrying.' AS remedy
 WHERE (SELECT prosrc FROM pg_proc WHERE oid='public.journal_lines_check_fx_residual_entries(uuid[])'::regprocedure) IS DISTINCT FROM $expected$ 
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
end  $expected$
UNION ALL
SELECT '0700.guard_definition' AS code,'refuse' AS severity,'public.journal_lines_check_fx_residual_entries(uuid[],boolean)' AS subject,
 'The authoritative FX guard differs from its published prerequisite definition.' AS detail,
 'Preserve the existing function and reconcile the exact published prerequisite through the native runner before retrying.' AS remedy
 WHERE (SELECT prosrc FROM pg_proc WHERE oid='public.journal_lines_check_fx_residual_entries(uuid[],boolean)'::regprocedure) IS DISTINCT FROM $expected$
declare
  v_bad_org uuid;
  v_bad_entry uuid;
  v_bad_subsidiary uuid;
  v_bad_deviation numeric(19, 4);
  v_bad_lines integer;
  v_bad_bound numeric;
begin
  -- Membership bounds the ledger lookup before aggregation. Multiplicity
  -- retains the original result even when a caller repeats an entry ID.
  -- Drafts continue to post through the entry-level balance gate.
  with entry_counts as materialized (
    select entry_id,count(*) as repetitions
      from unnest(p_entry_ids) as touched(entry_id)
     group by entry_id
  )
  select l.org_id, l.entry_id, l.subsidiary_id,
         sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4)) * touched.repetitions),
         sum(touched.repetitions),sum(touched.repetitions) * 0.00005
    into v_bad_org, v_bad_entry, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
    from public.journal_entries e
    join public.journal_lines l on l.entry_id=e.id
    join entry_counts touched on touched.entry_id=e.id
   where e.id=any(p_entry_ids) and e.status is distinct from 'draft'
   group by l.org_id, l.entry_id, l.subsidiary_id
  having sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4)) * touched.repetitions) > sum(touched.repetitions) * 0.00005
   limit 1;
  if found and p_new_posting then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): nothing was posted; correct the line exchange rates or functional amounts so each amount is its transaction amount times its rate, then post again',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  elsif found then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): posted lines cannot be amended; correct through the ledger API by posting a reversal and reposting instead of editing history',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  end if;
end $expected$
UNION ALL
SELECT '0700.instruction_guard_definition' AS code,'refuse' AS severity,'public.journal_instruction_line_guard' AS subject,
 'The controlled instruction-line guard differs from its published prerequisite definition.' AS detail,
 'Preserve the native adjustment identity and clone admission gates; reconcile the published guard before retrying.' AS remedy
 WHERE (SELECT prosrc FROM pg_proc WHERE oid='public.journal_instruction_line_guard()'::regprocedure) IS DISTINCT FROM $expected$
DECLARE head journal_entries%ROWTYPE; chosen_calendar uuid; chosen_period uuid; currency text; reversal_line journal_lines%ROWTYPE;
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
END $expected$;
