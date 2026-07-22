-- Cutover-grade accounting correctness remediation.
-- This migration is intentionally idempotent where trigger replacement is
-- concerned so an already-running parallel-books database can be hardened in
-- place without weakening or disabling any kernel constraint.

-- Migrations must see every tenant row while forced RLS remains enabled.
select set_config('app.bypass_rls', 'on', false);

-- Contract value is a native project accounting input, not a custom field.
alter table projects add column if not exists contract_value numeric(19,4);
update projects
   set contract_value = nullif(custom->>'contractValue', '')::numeric(19,4),
       custom = custom - 'contractValue'
 where custom ? 'contractValue';

create or replace function jl_check_balanced() returns trigger
language plpgsql as $$
declare
  v_entry uuid;
  v_new_entry uuid;
  v_old_entry uuid;
  v_sum numeric(19,4);
begin
  v_new_entry := case when tg_op = 'DELETE' then null else new.entry_id end;
  v_old_entry := case when tg_op in ('UPDATE', 'DELETE') then old.entry_id else null end;
  foreach v_entry in array array[v_new_entry, v_old_entry] loop
    if v_entry is null then continue; end if;
    select coalesce(sum(amount), 0) into v_sum from journal_lines where entry_id = v_entry;
    if v_sum <> 0 then
      raise exception 'journal entry % does not balance (sum = %)', v_entry, v_sum
        using errcode = '23514';
    end if;
  end loop;
  return null;
end $$;

create or replace function jl_check_balanced_by_subsidiary() returns trigger
language plpgsql as $$
declare
  v_entry uuid;
  v_new_entry uuid;
  v_old_entry uuid;
  v_bad record;
begin
  v_new_entry := case when tg_op = 'DELETE' then null else new.entry_id end;
  v_old_entry := case when tg_op in ('UPDATE', 'DELETE') then old.entry_id else null end;
  foreach v_entry in array array[v_new_entry, v_old_entry] loop
    if v_entry is null then continue; end if;
    select subsidiary_id, sum(amount) as total into v_bad
      from journal_lines where entry_id = v_entry
     group by subsidiary_id having sum(amount) <> 0 limit 1;
    if found then
      raise exception 'journal entry % does not balance for subsidiary % (sum = %)',
        v_entry, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
    end if;
  end loop;
  return null;
end $$;

create or replace function je_check_posted_balance() returns trigger
language plpgsql as $$
declare
  v_sum numeric(19,4);
  v_bad record;
begin
  if new.status <> 'posted' then return null; end if;
  select coalesce(sum(amount), 0) into v_sum from journal_lines where entry_id = new.id;
  if v_sum <> 0 then
    raise exception 'posted journal entry % does not balance (sum = %)', new.id, v_sum
      using errcode = '23514';
  end if;
  select subsidiary_id, sum(amount) as total into v_bad
    from journal_lines where entry_id = new.id
   group by subsidiary_id having sum(amount) <> 0 limit 1;
  if found then
    raise exception 'posted journal entry % does not balance for subsidiary % (sum = %)',
      new.id, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
  end if;
  if (select count(*) from journal_lines where entry_id = new.id) < 2 then
    raise exception 'posted journal entry % must contain at least two lines', new.id
      using errcode = '23514';
  end if;
  return null;
end $$;

drop trigger if exists je_posted_balanced on journal_entries;
create constraint trigger je_posted_balanced
  after insert or update of status on journal_entries
  deferrable initially deferred
  for each row execute function je_check_posted_balance();

-- Exact, componentized indirect tax -------------------------------------------------
alter table tax_codes
  add column if not exists calculation_type text not null default 'standard',
  add column if not exists withholding_account_id uuid,
  add column if not exists price_includes_tax boolean not null default false,
  add column if not exists compound_on_previous boolean not null default false,
  add column if not exists rounding_scale integer not null default 2;
alter table tax_codes drop constraint if exists tax_codes_calculation_type_check;
alter table tax_codes add constraint tax_codes_calculation_type_check
  check (calculation_type in ('standard', 'withholding', 'reverse_charge'));
alter table tax_codes drop constraint if exists tax_codes_rounding_scale_check;
alter table tax_codes add constraint tax_codes_rounding_scale_check check (rounding_scale between 0 and 4);

alter table tax_groups add column if not exists price_includes_tax boolean not null default false;

create unique index if not exists tax_group_members_code_unique
  on tax_group_members (tax_group_id, tax_code_id);
create unique index if not exists tax_group_members_sequence_unique
  on tax_group_members (tax_group_id, sequence);

create or replace function tax_group_member_validate() returns trigger language plpgsql as $$
declare group_org uuid; code_org uuid;
begin
  if new.sequence <= 0 then raise exception 'tax group member sequence must be positive'; end if;
  select org_id into group_org from tax_groups where id = new.tax_group_id;
  select org_id into code_org from tax_codes where id = new.tax_code_id;
  if group_org is null or code_org is null or group_org <> code_org then
    raise exception 'tax group and tax code must belong to the same organization';
  end if;
  return new;
end $$;
drop trigger if exists tax_group_member_validate_trigger on tax_group_members;
create trigger tax_group_member_validate_trigger before insert or update on tax_group_members
for each row execute function tax_group_member_validate();

alter table document_lines
  add column if not exists tax_group_id uuid,
  add column if not exists tax_input_amount numeric(19,4);
update document_lines set tax_input_amount = amount where tax_input_amount is null;
alter table document_lines drop constraint if exists doc_lines_one_tax_profile;
alter table document_lines add constraint doc_lines_one_tax_profile
  check (num_nonnulls(tax_code_id, tax_group_id) <= 1);

create table if not exists document_line_tax_components (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  document_line_id uuid not null,
  tax_code_id uuid not null,
  sequence integer not null,
  rate_percent numeric(19,4) not null,
  taxable_amount numeric(19,4) not null,
  tax_amount numeric(19,4) not null,
  recoverable_amount numeric(19,4) not null default 0,
  nonrecoverable_amount numeric(19,4) not null default 0,
  calculation_type text not null,
  price_includes_tax boolean not null default false,
  compound_on_previous boolean not null default false,
  rounding_scale integer not null default 2,
  collected_account_id uuid,
  paid_account_id uuid,
  withholding_account_id uuid,
  overridden boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint document_line_tax_components_nonnegative check (tax_amount >= 0),
  constraint document_line_tax_components_recovery_crossfoot
    check (recoverable_amount + nonrecoverable_amount = tax_amount),
  constraint document_line_tax_components_type
    check (calculation_type in ('standard', 'withholding', 'reverse_charge')),
  constraint document_line_tax_components_rounding_scale check (rounding_scale between 0 and 4)
);
create unique index if not exists document_line_tax_components_line_sequence
  on document_line_tax_components (document_line_id, sequence);
create index if not exists document_line_tax_components_code
  on document_line_tax_components (org_id, tax_code_id);

-- Preserve the explanation of legacy single-code rows as a one-component
-- snapshot. New/edited rows are always written by the exact tax engine.
insert into document_line_tax_components
  (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
   tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
   price_includes_tax, compound_on_previous, rounding_scale,
   collected_account_id, paid_account_id, withholding_account_id, overridden,
   created_by, updated_by)
select dl.org_id, dl.id, dl.tax_code_id, 1, coalesce(rate.rate_percent, 0), dl.amount,
       abs(dl.tax_amount),
       round(abs(dl.tax_amount) * tc.recoverable_percent / 100, 4),
       abs(dl.tax_amount) - round(abs(dl.tax_amount) * tc.recoverable_percent / 100, 4),
       tc.calculation_type, tc.price_includes_tax, tc.compound_on_previous,
       tc.rounding_scale, tc.collected_account_id, tc.paid_account_id,
       tc.withholding_account_id, dl.tax_overridden, dl.created_by, dl.updated_by
  from document_lines dl
  join documents d on d.id = dl.document_id
  join tax_codes tc on tc.id = dl.tax_code_id
  left join lateral (
    select tr.rate_percent from tax_rates tr
     where tr.tax_code_id = tc.id and tr.effective_from <= d.document_date
       and (tr.effective_to is null or tr.effective_to >= d.document_date)
     order by tr.effective_from desc limit 1
  ) rate on true
 where not exists (
   select 1 from document_line_tax_components c where c.document_line_id = dl.id
 ) and dl.tax_code_id is not null;

create or replace function document_line_tax_component_guard() returns trigger
language plpgsql as $$
declare v_status text;
declare v_org uuid;
begin
  v_org := case when tg_op = 'DELETE' then old.org_id else new.org_id end;
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(v_org) then return old; end if;
  select d.status into v_status
    from documents d join document_lines dl on dl.document_id = d.id
   where dl.id = case when tg_op = 'DELETE' then old.document_line_id else new.document_line_id end;
  if v_status <> 'draft' and coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
    raise exception 'posted tax calculation evidence is immutable';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists document_line_tax_component_guard on document_line_tax_components;
create trigger document_line_tax_component_guard
  before insert or update or delete on document_line_tax_components
  for each row execute function document_line_tax_component_guard();

-- Realized-FX applications carry distinct source and target functional values.
alter table applications
  add column if not exists source_amount numeric(19,4),
  add column if not exists transaction_amount numeric(19,4),
  add column if not exists transaction_currency text;
update applications a
   set source_amount = coalesce(a.source_amount, a.amount),
       transaction_amount = coalesce(a.transaction_amount, round(a.amount / tl.fx_rate, 4)),
       transaction_currency = coalesce(a.transaction_currency, tl.currency)
  from journal_lines tl where tl.id = a.to_line_id
    and (a.source_amount is null or a.transaction_amount is null or a.transaction_currency is null);
alter table applications
  alter column source_amount set not null,
  alter column transaction_amount set not null,
  alter column transaction_currency set not null;
alter table applications drop constraint if exists app_source_positive;
alter table applications add constraint app_source_positive check (source_amount > 0);
alter table applications drop constraint if exists app_transaction_positive;
alter table applications add constraint app_transaction_positive check (transaction_amount > 0);

create or replace function app_validate_endpoints() returns trigger
language plpgsql as $$
declare
  v_from journal_lines%rowtype;
  v_to journal_lines%rowtype;
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
  if v_from.currency <> new.transaction_currency or v_to.currency <> new.transaction_currency then
    raise exception 'application transaction currency must match both journal lines' using errcode = '23514';
  end if;
  select count(*) into v_status_count from journal_entries
   where id in (v_from.entry_id, v_to.entry_id) and status = 'posted';
  if v_status_count <> 2 then
    raise exception 'applications may only connect posted journal entries' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists app_validate_endpoints on applications;
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
    raise exception 'application exceeds open amount on target line % (% applied of %)',
      new.to_line_id, v_applied + new.amount, v_line using errcode = '23514';
  end if;
  select abs(txn_amount) into v_line from journal_lines where id = new.to_line_id;
  select coalesce(sum(transaction_amount), 0) into v_transaction from applications
   where to_line_id = new.to_line_id and unapplied_at is null and id <> new.id;
  if v_transaction + new.transaction_amount > v_line then
    raise exception 'application exceeds transaction amount on target line %', new.to_line_id using errcode = '23514';
  end if;
  select abs(amount) into v_line from journal_lines where id = new.from_line_id;
  select coalesce(sum(source_amount), 0) into v_applied from applications
   where from_line_id = new.from_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.source_amount > v_line then
    raise exception 'application exceeds available amount on source line %', new.from_line_id
      using errcode = '23514';
  end if;
  select abs(txn_amount) into v_line from journal_lines where id = new.from_line_id;
  select coalesce(sum(transaction_amount), 0) into v_transaction from applications
   where from_line_id = new.from_line_id and unapplied_at is null and id <> new.id;
  if v_transaction + new.transaction_amount > v_line then
    raise exception 'application exceeds transaction amount on source line %', new.from_line_id using errcode = '23514';
  end if;
  return new;
end $$;

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
     or new.transaction_amount is distinct from old.transaction_amount
     or new.transaction_currency is distinct from old.transaction_currency
     or new.applied_on is distinct from old.applied_on
     or new.fx_gain_loss_entry_id is distinct from old.fx_gain_loss_entry_id
     or old.unapplied_at is not null or new.unapplied_at is null then
    raise exception 'application evidence is immutable; only a one-time unapply is allowed';
  end if;
  return new;
end $$;

drop trigger if exists application_evidence_guard on applications;
create trigger application_evidence_guard before update or delete on applications
  for each row execute function application_evidence_guard();

grant select on document_line_tax_components to openbooks_read;
alter table document_line_tax_components enable row level security;
alter table document_line_tax_components force row level security;
drop policy if exists org_isolation on document_line_tax_components;
create policy org_isolation on document_line_tax_components
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true)
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true)
  );
