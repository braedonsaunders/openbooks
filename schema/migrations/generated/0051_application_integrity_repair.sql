-- Idempotent repair for application rows imported before endpoint validation
-- existed. Live impossible links are unapplied, never rewritten as legitimate
-- settlements; their rows remain immutable audit evidence.

set local app.bypass_rls = 'on';

drop trigger if exists application_evidence_guard on applications;
drop trigger if exists app_validate_endpoints on applications;

update applications a
   set source_transaction_currency = source_line.currency,
       target_transaction_currency = target_line.currency,
       settlement_rate_source = case when source_line.currency = target_line.currency then 'same_currency' else 'imported' end,
       settlement_rate_reference = case
         when not source_line.is_open_item or not target_line.is_open_item
           or source_line.account_id <> target_line.account_id
           or source_line.party_id is distinct from target_line.party_id
           or source_line.subsidiary_id <> target_line.subsidiary_id
           or sign(source_line.amount) = sign(target_line.amount)
         then 'migration-unapplied invalid legacy application'
         else a.settlement_rate_reference
       end,
       unapplied_at = case
         when not source_line.is_open_item or not target_line.is_open_item
           or source_line.account_id <> target_line.account_id
           or source_line.party_id is distinct from target_line.party_id
           or source_line.subsidiary_id <> target_line.subsidiary_id
           or sign(source_line.amount) = sign(target_line.amount)
         then coalesce(a.unapplied_at, now())
         else a.unapplied_at
       end
  from journal_lines source_line, journal_lines target_line
 where source_line.id = a.from_line_id and target_line.id = a.to_line_id
   and (
     a.source_transaction_currency <> source_line.currency
     or a.target_transaction_currency <> target_line.currency
     or (
       a.unapplied_at is null and (
         not source_line.is_open_item or not target_line.is_open_item
         or source_line.account_id <> target_line.account_id
         or source_line.party_id is distinct from target_line.party_id
         or source_line.subsidiary_id <> target_line.subsidiary_id
         or sign(source_line.amount) = sign(target_line.amount)
       )
     )
   );

create or replace function app_validate_endpoints() returns trigger
language plpgsql as $$
declare
  v_from journal_lines%rowtype;
  v_to journal_lines%rowtype;
  v_fx fx_rates%rowtype;
  v_status_count integer;
begin
  perform id from journal_lines where id in (new.from_line_id, new.to_line_id) order by id for update;
  select * into v_from from journal_lines where id = new.from_line_id;
  select * into v_to from journal_lines where id = new.to_line_id;
  if v_from.id is null or v_to.id is null or v_from.id = v_to.id then
    raise exception 'application endpoints must be two distinct journal lines' using errcode = '23514';
  end if;
  if v_from.org_id <> new.org_id or v_to.org_id <> new.org_id or v_from.org_id <> v_to.org_id then
    raise exception 'application endpoints must belong to the application tenant' using errcode = '23514';
  end if;
  if new.unapplied_at is not null then return new; end if;
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
  if v_from.currency <> new.source_transaction_currency or v_to.currency <> new.target_transaction_currency then
    raise exception 'application source and target currencies must match their journal lines' using errcode = '23514';
  end if;
  if abs(new.target_transaction_amount - round(new.source_transaction_amount * new.settlement_rate, 4)) > 0.0001 then
    raise exception 'application settlement rate does not cross-foot source and target transaction amounts' using errcode = '23514';
  end if;
  if new.source_transaction_currency = new.target_transaction_currency then
    if new.source_transaction_amount <> new.target_transaction_amount
       or new.settlement_rate <> 1 or new.settlement_rate_source <> 'same_currency' then
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
    if v_fx.id is null or v_fx.org_id <> new.org_id
       or v_fx.from_currency <> new.source_transaction_currency
       or v_fx.to_currency <> new.target_transaction_currency
       or v_fx.rate <> new.settlement_rate or v_fx.as_of > new.applied_on then
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

create trigger app_validate_endpoints before insert or update on applications
  for each row execute function app_validate_endpoints();
create trigger application_evidence_guard before update or delete on applications
  for each row execute function application_evidence_guard();
