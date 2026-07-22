-- Complete fixed-asset operating controls: native account overrides, selectable
-- formula methods, and relational file evidence for input-driven depreciation.

alter table asset_categories
  add column if not exists default_depreciation_method_id uuid;

alter table fixed_assets
  add column if not exists depreciation_method_id uuid,
  add column if not exists asset_account_id uuid,
  add column if not exists accumulated_depreciation_account_id uuid,
  add column if not exists depreciation_expense_account_id uuid;

alter table depreciation_schedules
  add column if not exists depreciation_method_id uuid;

alter table depreciation_book_policies
  add column if not exists depreciation_method_id uuid;

-- Refuse to discard malformed legacy overrides. Valid overrides are promoted
-- into typed columns, then the obsolete product-owned JSON key is removed.
do $$
begin
  if exists (
    select 1
      from fixed_assets a
     where a.custom ? 'accounts'
       and exists (
         select 1
           from jsonb_each_text(a.custom->'accounts') value
          where value.key in ('asset', 'accumulated', 'expense')
            and case
              when value.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                then not exists (select 1 from accounts ac where ac.id = value.value::uuid and ac.org_id = a.org_id)
              else true
            end
       )
  ) then
    raise exception 'fixed asset account overrides contain an invalid or cross-tenant account';
  end if;
end $$;

update fixed_assets
   set asset_account_id = coalesce(asset_account_id, nullif(custom->'accounts'->>'asset', '')::uuid),
       accumulated_depreciation_account_id = coalesce(accumulated_depreciation_account_id, nullif(custom->'accounts'->>'accumulated', '')::uuid),
       depreciation_expense_account_id = coalesce(depreciation_expense_account_id, nullif(custom->'accounts'->>'expense', '')::uuid),
       custom = custom - 'accounts'
 where custom ? 'accounts';

do $$
begin
  if exists (select 1 from depreciation_inputs) then
    raise exception 'existing depreciation inputs require evidence-file remediation before migration 0052';
  end if;
end $$;

alter table depreciation_inputs
  add column if not exists evidence_file_id uuid;
alter table depreciation_inputs
  alter column evidence_file_id set not null,
  drop column if exists evidence_reference;

alter table asset_categories
  drop constraint if exists asset_categories_default_depreciation_method_fk,
  add constraint asset_categories_default_depreciation_method_fk foreign key (default_depreciation_method_id) references depreciation_methods(id);
alter table fixed_assets
  drop constraint if exists fixed_assets_depreciation_method_fk,
  drop constraint if exists fixed_assets_asset_account_fk,
  drop constraint if exists fixed_assets_accumulated_account_fk,
  drop constraint if exists fixed_assets_expense_account_fk,
  add constraint fixed_assets_depreciation_method_fk foreign key (depreciation_method_id) references depreciation_methods(id),
  add constraint fixed_assets_asset_account_fk foreign key (asset_account_id) references accounts(id),
  add constraint fixed_assets_accumulated_account_fk foreign key (accumulated_depreciation_account_id) references accounts(id),
  add constraint fixed_assets_expense_account_fk foreign key (depreciation_expense_account_id) references accounts(id);
alter table depreciation_schedules
  drop constraint if exists depreciation_schedules_method_fk,
  add constraint depreciation_schedules_method_fk foreign key (depreciation_method_id) references depreciation_methods(id);
alter table depreciation_book_policies
  drop constraint if exists depreciation_book_policies_method_fk,
  add constraint depreciation_book_policies_method_fk foreign key (depreciation_method_id) references depreciation_methods(id);
alter table depreciation_inputs
  drop constraint if exists depreciation_inputs_evidence_file_fk,
  add constraint depreciation_inputs_evidence_file_fk foreign key (evidence_file_id) references files(id);

create index if not exists fixed_assets_depreciation_method on fixed_assets(org_id, depreciation_method_id);
create index if not exists fixed_assets_account_overrides on fixed_assets(org_id, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id);
create index if not exists depreciation_inputs_evidence_file on depreciation_inputs(org_id, evidence_file_id);

create or replace function openbooks_guard_depreciation_evidence()
returns trigger language plpgsql as $$
declare
  posted boolean;
begin
  if current_setting('openbooks.sandbox_wipe', true) = 'on' then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    raise exception 'depreciation input evidence is append-preserved';
  end if;
  select exists (select 1 from depreciation_schedule_lines where input_id=old.id and posted_amount is not null) into posted;
  if posted then raise exception 'posted depreciation input evidence is immutable'; end if;
  if old.voided_at is not null
     or new.voided_at is null or new.voided_by is null
     or new.org_id is distinct from old.org_id
     or new.schedule_id is distinct from old.schedule_id
     or new.period_id is distinct from old.period_id
     or new.kind is distinct from old.kind
     or new.manual_amount is distinct from old.manual_amount
     or new.production_units is distinct from old.production_units
     or new.memo is distinct from old.memo
     or new.evidence_file_id is distinct from old.evidence_file_id
     or new.supersedes_input_id is distinct from old.supersedes_input_id
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'depreciation input evidence may only be voided before posting';
  end if;
  return new;
end $$;
drop trigger if exists depreciation_input_evidence_guard on depreciation_inputs;
create trigger depreciation_input_evidence_guard before update or delete on depreciation_inputs
  for each row execute function openbooks_guard_depreciation_evidence();

create or replace function fixed_asset_configuration_org_guard() returns trigger language plpgsql as $$
declare
  method_id uuid;
  account_ids uuid[];
begin
  if tg_table_name = 'asset_categories' then
    method_id := new.default_depreciation_method_id;
  elsif tg_table_name = 'fixed_assets' then
    method_id := new.depreciation_method_id;
    account_ids := array_remove(array[new.asset_account_id, new.accumulated_depreciation_account_id, new.depreciation_expense_account_id], null);
  elsif tg_table_name = 'depreciation_schedules' or tg_table_name = 'depreciation_book_policies' then
    method_id := new.depreciation_method_id;
  end if;
  if method_id is not null and not exists (
    select 1 from depreciation_methods m where m.id = method_id and m.org_id = new.org_id and m.is_active
  ) then
    raise exception 'depreciation method must be active and belong to the tenant';
  end if;
  if cardinality(account_ids) > 0 and exists (
    select 1 from unnest(account_ids) wanted(id)
     where not exists (select 1 from accounts a where a.id = wanted.id and a.org_id = new.org_id and a.is_active and not a.is_summary)
  ) then
    raise exception 'fixed asset account override must be an active postable account in the tenant';
  end if;
  return new;
end $$;

drop trigger if exists asset_categories_configuration_org_guard on asset_categories;
create trigger asset_categories_configuration_org_guard before insert or update on asset_categories
  for each row execute function fixed_asset_configuration_org_guard();
drop trigger if exists fixed_assets_configuration_org_guard on fixed_assets;
create trigger fixed_assets_configuration_org_guard before insert or update on fixed_assets
  for each row execute function fixed_asset_configuration_org_guard();
drop trigger if exists depreciation_schedules_configuration_org_guard on depreciation_schedules;
create trigger depreciation_schedules_configuration_org_guard before insert or update on depreciation_schedules
  for each row execute function fixed_asset_configuration_org_guard();
drop trigger if exists depreciation_book_policies_configuration_org_guard on depreciation_book_policies;
create trigger depreciation_book_policies_configuration_org_guard before insert or update on depreciation_book_policies
  for each row execute function fixed_asset_configuration_org_guard();

-- A formula id is the schedule's calculation-version evidence. Once used,
-- change the method by creating a new version instead of rewriting history.
create or replace function depreciation_method_definition_guard() returns trigger language plpgsql as $$
begin
  if (new.org_id is distinct from old.org_id
      or new.formula is distinct from old.formula
      or new.end_of_life is distinct from old.end_of_life
      or new.is_active is distinct from old.is_active) and exists (
    select 1 from depreciation_schedules s where s.depreciation_method_id = old.id
  ) then
    raise exception 'a depreciation formula used by a schedule is immutable; create a new method version';
  end if;
  return new;
end $$;
drop trigger if exists depreciation_method_definition_guard on depreciation_methods;
create trigger depreciation_method_definition_guard before update on depreciation_methods
  for each row execute function depreciation_method_definition_guard();

create or replace function depreciation_input_file_guard() returns trigger language plpgsql as $$
declare
  owning_asset uuid;
begin
  select s.asset_id into owning_asset
    from depreciation_schedules s
   where s.id = new.schedule_id and s.org_id = new.org_id;
  if owning_asset is null then
    raise exception 'depreciation input schedule must belong to the tenant';
  end if;
  if not exists (select 1 from files f where f.id = new.evidence_file_id and f.org_id = new.org_id and not f.is_inactive) then
    raise exception 'depreciation evidence file must be active and belong to the tenant';
  end if;
  if not exists (
    select 1 from file_attachments fa
     where fa.org_id = new.org_id and fa.file_id = new.evidence_file_id
       and fa.target_table = 'fixed_assets' and fa.target_id = owning_asset
  ) then
    raise exception 'depreciation evidence file must be attached to the owning fixed asset';
  end if;
  return new;
end $$;

drop trigger if exists depreciation_input_file_guard on depreciation_inputs;
create trigger depreciation_input_file_guard before insert or update on depreciation_inputs
  for each row execute function depreciation_input_file_guard();

create or replace function depreciation_evidence_attachment_guard() returns trigger language plpgsql as $$
begin
  if current_setting('openbooks.sandbox_wipe', true) = 'on' then return coalesce(new, old); end if;
  if old.target_table = 'fixed_assets' and exists (
    select 1
      from depreciation_inputs i
      join depreciation_schedules s on s.id = i.schedule_id
     where i.org_id = old.org_id and i.evidence_file_id = old.file_id and s.asset_id = old.target_id
  ) then
    raise exception 'file attachment is retained by depreciation evidence';
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists depreciation_evidence_attachment_guard on file_attachments;
create trigger depreciation_evidence_attachment_guard before update or delete on file_attachments
  for each row execute function depreciation_evidence_attachment_guard();

grant select on depreciation_inputs to openbooks_read;
