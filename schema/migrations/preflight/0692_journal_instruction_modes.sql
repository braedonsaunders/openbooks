-- Preserve published ledger guard definitions before extending typed adjustment evidence.
SELECT '0692.guard_definition' AS code,'refuse' AS severity,'public.je_check_posted_balance' AS subject,
 'The native ledger guard differs from its published definition.' AS detail,
 'Preserve the function and obtain owner-approved reconciliation before retrying the native upgrade.' AS remedy
 WHERE (SELECT prosrc FROM pg_proc WHERE oid='public.je_check_posted_balance()'::regprocedure) IS DISTINCT FROM $expected$
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
         sum(abs(amount - round(txn_amount * fx_rate, 4))) as deviation,
         count(*) as lines,
         count(*) * 0.00005 as bound into v_fx
    from journal_lines
   where entry_id = new.id and org_id = new.org_id
   group by subsidiary_id
  having sum(abs(amount - round(txn_amount * fx_rate, 4))) > count(*) * 0.00005 limit 1;
  -- This gate fires when an entry becomes posted: inserted posted, or a
  -- draft flipped to posted. Either way nothing has been posted yet.
  if found then
    raise exception 'posted journal entry % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): nothing was posted; correct the line exchange rates or functional amounts so each amount is its transaction amount times its rate, then post again',
      new.id, v_fx.subsidiary_id, v_fx.deviation, v_fx.lines, v_fx.bound using errcode = '23514';
  end if;
  if (select count(*) from journal_lines where entry_id = new.id and org_id = new.org_id) < 2 then
    raise exception 'posted journal entry % must contain at least two lines', new.id
      using errcode = '23514';
  end if;
  return null;
end $expected$;
SELECT '0692.guard_definition' AS code,'refuse' AS severity,'public.journal_lines_check_fx_residual_entries' AS subject,
 'The native ledger guard differs from its published definition.' AS detail,
 'Preserve the function and obtain owner-approved reconciliation before retrying the native upgrade.' AS remedy
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
         sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4))),
         count(*), count(*) * 0.00005
    into v_bad_org, v_bad_entry, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
   where e.status is distinct from 'draft'
   group by l.org_id, l.entry_id, l.subsidiary_id
  having sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4))) > count(*) * 0.00005
   limit 1;
  if found then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): correct through the ledger API by posting a reversal and reposting instead of editing history',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  end if;
end $expected$;
SELECT '0692.fx_constraint_definition' AS code,'refuse' AS severity,'journal_lines.jl_fx_consistent' AS subject,
 'The native FX consistency constraint differs from its published definition.' AS detail,
 'Preserve the constraint and reconcile it with the published baseline before retrying.' AS remedy
 WHERE (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.journal_lines'::regclass AND conname='jl_fx_consistent')
 IS DISTINCT FROM 'CHECK ((abs((amount - round((txn_amount * fx_rate), 4))) <= 0.005))';
