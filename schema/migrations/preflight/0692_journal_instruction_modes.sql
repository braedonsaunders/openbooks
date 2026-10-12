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
end $expected$
UNION ALL
SELECT '0692.guard_definition' AS code,'refuse' AS severity,'public.journal_lines_check_fx_residual_entries' AS subject,
 'The native ledger guard differs from its published definition.' AS detail,
 'Preserve the function and obtain owner-approved reconciliation before retrying the native upgrade.' AS remedy
 WHERE (SELECT prosrc FROM pg_proc WHERE oid='public.journal_lines_check_fx_residual_entries(uuid[])'::regprocedure) IS DISTINCT FROM $expected$
begin
  perform public.journal_lines_check_fx_residual_entries(p_entry_ids, false);
end $expected$
UNION ALL
SELECT '0692.fx_constraint_definition' AS code,'refuse' AS severity,'journal_lines.jl_fx_consistent' AS subject,
 'The native FX consistency constraint differs from its published definition.' AS detail,
 'Preserve the constraint and reconcile it with the published baseline before retrying.' AS remedy
 WHERE (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.journal_lines'::regclass AND conname='jl_fx_consistent')
 IS DISTINCT FROM 'CHECK ((abs((amount - round((txn_amount * fx_rate), 4))) <= 0.005))';
