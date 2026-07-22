-- Cross-currency settlement evidence. Applications retain both transaction
-- currencies and both functional carrying amounts; no currency conversion is
-- inferred later from mutable rate tables.

set local app.bypass_rls = 'on';

alter table applications
  add column source_transaction_amount numeric(19,4),
  add column source_transaction_currency text,
  add column target_transaction_amount numeric(19,4),
  add column target_transaction_currency text,
  add column settlement_rate numeric(19,10),
  add column settlement_rate_source text,
  add column settlement_rate_reference text,
  add column settlement_fx_rate_id uuid;

-- The immutable-evidence trigger correctly blocks ordinary edits. This
-- transaction is the one-time shape migration; it is recreated below before
-- commit with the expanded evidence field set.
drop trigger if exists application_evidence_guard on applications;
drop trigger if exists app_validate_endpoints on applications;
drop trigger if exists app_check_open on applications;

-- Every pre-cutover application used one shared transaction currency.
update applications a
   set source_transaction_amount = a.transaction_amount,
       source_transaction_currency = source_line.currency,
       target_transaction_amount = a.transaction_amount,
       target_transaction_currency = target_line.currency,
       settlement_rate = 1,
       settlement_rate_source = case when source_line.currency = target_line.currency then 'same_currency' else 'imported' end,
       settlement_rate_reference = 'migrated application evidence'
  from journal_lines source_line, journal_lines target_line
 where source_line.id = a.from_line_id and target_line.id = a.to_line_id;

-- Historical imports created before the endpoint trigger existed may contain
-- impossible links. Preserve those rows as immutable evidence but remove their
-- open-item effect instead of legitimizing a corrupt settlement.
update applications a
   set unapplied_at = coalesce(a.unapplied_at, now()),
       settlement_rate_reference = 'migration-unapplied invalid legacy application'
  from journal_lines source_line, journal_lines target_line
 where source_line.id = a.from_line_id and target_line.id = a.to_line_id
   and a.unapplied_at is null
   and (
     not source_line.is_open_item or not target_line.is_open_item
     or source_line.account_id <> target_line.account_id
     or source_line.party_id is distinct from target_line.party_id
     or source_line.subsidiary_id <> target_line.subsidiary_id
     or sign(source_line.amount) = sign(target_line.amount)
   );

-- Draft payment working state used the same-currency `amount` shape. Rewrite
-- it once so the engine has no compatibility branch after cutover.
with rewritten as (
  select d.id,
         coalesce(jsonb_agg(
           (item - 'amount' - 'baseAmount') || jsonb_strip_nulls(jsonb_build_object(
             'sourceTransactionAmount', item->>'amount',
             'targetTransactionAmount', item->>'amount',
             'targetBaseAmount', item->>'baseAmount',
             'settlementRate', '1',
             'settlementRateSource', 'same_currency',
             'settlementRateReference', 'same transaction currency'
           ))
         ), '[]'::jsonb) as allocations
    from documents d
    cross join lateral jsonb_array_elements(coalesce(d.custom->'allocations', '[]'::jsonb)) item
   where d.kind in ('vendor_payment', 'customer_payment')
     and d.status = 'draft'
     and jsonb_typeof(coalesce(d.custom->'allocations', '[]'::jsonb)) = 'array'
   group by d.id
)
update documents d
   set custom = jsonb_set(d.custom, '{allocations}', rewritten.allocations, true)
  from rewritten
 where rewritten.id = d.id;

alter table applications
  alter column source_transaction_amount set not null,
  alter column source_transaction_currency set not null,
  alter column target_transaction_amount set not null,
  alter column target_transaction_currency set not null,
  alter column settlement_rate set not null,
  alter column settlement_rate_source set not null,
  alter column settlement_rate_reference set not null;

alter table applications
  drop constraint if exists app_transaction_positive,
  drop column transaction_amount,
  drop column transaction_currency,
  add constraint app_source_transaction_positive check (source_transaction_amount > 0),
  add constraint app_target_transaction_positive check (target_transaction_amount > 0),
  add constraint app_settlement_rate_positive check (settlement_rate > 0),
  add constraint app_rate_reference_required check (length(btrim(settlement_rate_reference)) > 0),
  add constraint app_rate_source_valid check (
    settlement_rate_source in ('same_currency', 'provider', 'manual', 'contractual', 'imported')
  ),
  add constraint applications_settlement_fx_rate_fk
    foreign key (settlement_fx_rate_id) references fx_rates(id) on delete restrict;

create index applications_settlement_fx_rate on applications (settlement_fx_rate_id);

create or replace function app_validate_endpoints() returns trigger
language plpgsql as $$
declare
  v_from journal_lines%rowtype;
  v_to journal_lines%rowtype;
  v_fx fx_rates%rowtype;
  v_status_count integer;
begin
  perform id from journal_lines
   where id in (new.from_line_id, new.to_line_id)
   order by id for update;
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

create trigger app_validate_endpoints before insert or update on applications
  for each row execute function app_validate_endpoints();

create or replace function app_check_open() returns trigger
language plpgsql as $$
declare
  v_line numeric(19,4);
  v_applied numeric(19,4);
  v_transaction numeric(19,4);
begin
  if new.unapplied_at is not null then return new; end if;
  select abs(amount) into v_line from journal_lines where id = new.to_line_id;
  select coalesce(sum(amount), 0) into v_applied from applications
   where to_line_id = new.to_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.amount > v_line then
    raise exception 'application exceeds open amount on target line %', new.to_line_id using errcode = '23514';
  end if;
  select abs(txn_amount) into v_line from journal_lines where id = new.to_line_id;
  select coalesce(sum(target_transaction_amount), 0) into v_transaction from applications
   where to_line_id = new.to_line_id and unapplied_at is null and id <> new.id;
  if v_transaction + new.target_transaction_amount > v_line then
    raise exception 'application exceeds transaction amount on target line %', new.to_line_id using errcode = '23514';
  end if;
  select abs(amount) into v_line from journal_lines where id = new.from_line_id;
  select coalesce(sum(source_amount), 0) into v_applied from applications
   where from_line_id = new.from_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.source_amount > v_line then
    raise exception 'application exceeds available amount on source line %', new.from_line_id using errcode = '23514';
  end if;
  select abs(txn_amount) into v_line from journal_lines where id = new.from_line_id;
  select coalesce(sum(source_transaction_amount), 0) into v_transaction from applications
   where from_line_id = new.from_line_id and unapplied_at is null and id <> new.id;
  if v_transaction + new.source_transaction_amount > v_line then
    raise exception 'application exceeds transaction amount on source line %', new.from_line_id using errcode = '23514';
  end if;
  return new;
end $$;

create constraint trigger app_check_open
  after insert or update on applications
  deferrable initially deferred
  for each row execute function app_check_open();

create or replace function application_evidence_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if openbooks_sandbox_wipe_allowed(old.org_id) then return old; end if;
    raise exception 'application evidence is immutable; unapply it instead';
  end if;
  if new.org_id is distinct from old.org_id
     or new.from_line_id is distinct from old.from_line_id
     or new.to_line_id is distinct from old.to_line_id
     or new.amount is distinct from old.amount
     or new.source_amount is distinct from old.source_amount
     or new.source_transaction_amount is distinct from old.source_transaction_amount
     or new.source_transaction_currency is distinct from old.source_transaction_currency
     or new.target_transaction_amount is distinct from old.target_transaction_amount
     or new.target_transaction_currency is distinct from old.target_transaction_currency
     or new.settlement_rate is distinct from old.settlement_rate
     or new.settlement_rate_source is distinct from old.settlement_rate_source
     or new.settlement_rate_reference is distinct from old.settlement_rate_reference
     or new.settlement_fx_rate_id is distinct from old.settlement_fx_rate_id
     or new.applied_on is distinct from old.applied_on
     or new.fx_gain_loss_entry_id is distinct from old.fx_gain_loss_entry_id
     or old.unapplied_at is not null
     or new.unapplied_at is null then
    raise exception 'application evidence is immutable; only a one-time unapply is allowed';
  end if;
  return new;
end $$;

create trigger application_evidence_guard before update or delete on applications
  for each row execute function application_evidence_guard();
