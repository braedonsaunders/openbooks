-- OpenBooks forward migration 0101_application_book_scope.
-- Preserve all endpoint/evidence controls, adding equality of accounting books.
-- Existing application evidence is retained; erroneous links must be unapplied
-- through the controlled correction workflow, never rewritten by migration.

CREATE OR REPLACE FUNCTION public.app_validate_endpoints() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_from journal_lines%rowtype;
  v_to journal_lines%rowtype;
  v_fx fx_rates%rowtype;
  v_status_count integer;
begin
  -- Bulk migration / sandbox-clone copies pre-validated application rows through
  -- ob_rebase before their journal lines exist in the target, so this row-by-row
  -- cross-reference check can't hold mid-copy. 'set local openbooks.migration = on'
  -- (transaction-scoped, direct-DB only) relaxes it; every normal write still
  -- validates in full.
  if coalesce(current_setting('openbooks.migration', true), 'off') = 'on' then
    return new;
  end if;
  -- Deterministic row locks serialize competing applications to either line.
  perform id from journal_lines
   where id in (new.from_line_id, new.to_line_id)
   order by id for update;
  select * into v_from from journal_lines where id = new.from_line_id;
  select * into v_to from journal_lines where id = new.to_line_id;
  if v_from.id is null or v_to.id is null or v_from.id = v_to.id then
    raise exception 'application endpoints must be two distinct journal lines' using errcode = '23514';
  end if;
  if v_from.org_id <> new.org_id or v_to.org_id <> new.org_id
     or v_from.org_id <> v_to.org_id then
    raise exception 'application endpoints must belong to the application tenant' using errcode = '23514';
  end if;
  if new.unapplied_at is not null then return new; end if;
  -- Parallel accounting books are representations, not additional balances.
  -- Posted entry book identity is immutable. The existing sorted endpoint
  -- locks below the migration exemption continue to serialize allocations.
  -- Keep this after the unapply return so legacy invalid evidence can be
  -- corrected through the ordinary audited unapplication lifecycle.
  if not exists (
    select 1 from journal_entries source_entry
    join journal_entries target_entry
      on target_entry.id = v_to.entry_id
     and target_entry.org_id = new.org_id
     and target_entry.book_id = source_entry.book_id
    where source_entry.id = v_from.entry_id
      and source_entry.org_id = new.org_id
  ) then
    raise exception 'application endpoints must share an accounting book' using errcode = '23514';
  end if;
  if not v_from.is_open_item or not v_to.is_open_item then
    raise exception 'applications require open-item journal lines' using errcode = '23514';
  end if;
  if v_from.account_id <> v_to.account_id
     or v_from.party_id is distinct from v_to.party_id
     or v_from.subsidiary_id <> v_to.subsidiary_id then
    raise exception 'application endpoints must share account, party, and subsidiary' using errcode = '23514';
  end if;
  if sign(v_from.amount) = sign(v_to.amount) then
    raise exception 'application endpoints must have opposite debit/credit signs' using errcode = '23514';
  end if;
  if v_from.currency <> new.source_transaction_currency
     or v_to.currency <> new.target_transaction_currency then
    raise exception 'application source and target currencies must match their journal lines' using errcode = '23514';
  end if;
  if abs(new.target_transaction_amount - round(new.source_transaction_amount * new.settlement_rate, 4)) > 0.0001 then
    raise exception 'application settlement rate does not cross-foot source and target transaction amounts' using errcode = '23514';
  end if;
  if new.source_transaction_currency = new.target_transaction_currency then
    if new.source_transaction_amount <> new.target_transaction_amount
       or new.settlement_rate <> 1
       or new.settlement_rate_source <> 'same_currency' then
      raise exception 'same-currency applications require equal transaction amounts and a rate of one' using errcode = '23514';
    end if;
  elsif new.settlement_rate_source = 'same_currency' then
    raise exception 'cross-currency applications require explicit settlement-rate evidence' using errcode = '23514';
  end if;
  if new.settlement_rate_source = 'provider' and new.settlement_fx_rate_id is null then
    raise exception 'provider settlement evidence requires an FX rate observation' using errcode = '23514';
  end if;
  if new.settlement_fx_rate_id is not null then
    select * into v_fx from fx_rates where id = new.settlement_fx_rate_id;
    if v_fx.id is null
       or v_fx.org_id <> new.org_id
       or v_fx.from_currency <> new.source_transaction_currency
       or v_fx.to_currency <> new.target_transaction_currency
       or v_fx.rate <> new.settlement_rate
       or v_fx.as_of > new.applied_on then
      raise exception 'settlement FX observation does not match the application evidence' using errcode = '23514';
    end if;
  end if;
  select count(*) into v_status_count from journal_entries
   where id in (v_from.entry_id, v_to.entry_id) and status = 'posted';
  if v_status_count <> 2 then
    raise exception 'applications may only connect posted journal entries' using errcode = '23514';
  end if;
  return new;
end $$;
