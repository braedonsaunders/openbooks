-- Schema/data backfill must see one stable asset-register snapshot. Production
-- migrations run transactionally; this lock also prevents a depreciation or
-- source-import job from creating a half-migrated row during validation.
select set_config('app.bypass_rls', 'on', false);
lock table fixed_assets, depreciation_schedules, depreciation_schedule_lines in access exclusive mode;

alter table fixed_assets
  drop constraint if exists fixed_assets_depreciation_method_check,
  drop constraint if exists fixed_assets_depreciation_convention_check,
  drop constraint if exists fixed_assets_positive_useful_life,
  drop constraint if exists fixed_assets_nonnegative_depreciation_rate,
  drop constraint if exists fixed_assets_positive_depreciation_units;
alter table fixed_assets
  add column if not exists depreciation_method text,
  add column if not exists useful_life_months integer,
  add column if not exists depreciation_rate_percent numeric(19,4),
  add column if not exists depreciation_convention text,
  add column if not exists depreciation_units_total numeric(19,4);

alter table fixed_assets
  add constraint fixed_assets_depreciation_method_check
    check (depreciation_method is null or depreciation_method in
      ('straight_line', 'declining_balance', 'double_declining', 'units_of_production', 'manual')),
  add constraint fixed_assets_depreciation_convention_check
    check (depreciation_convention is null or depreciation_convention in ('full_month', 'mid_month', 'half_year')),
  add constraint fixed_assets_positive_useful_life
    check (useful_life_months is null or useful_life_months > 0),
  add constraint fixed_assets_nonnegative_depreciation_rate
    check (depreciation_rate_percent is null or depreciation_rate_percent >= 0),
  add constraint fixed_assets_positive_depreciation_units
    check (depreciation_units_total is null or depreciation_units_total > 0);

-- Retire the old native-settings-in-custom path in place. Invalid historical
-- values remain null and must be corrected explicitly instead of being guessed.
update fixed_assets
   set depreciation_method = case
         when custom->>'method' in ('straight_line', 'declining_balance', 'double_declining', 'units_of_production', 'manual')
           then custom->>'method'
         else depreciation_method
       end,
       useful_life_months = case
         when custom->>'lifeMonths' ~ '^[1-9][0-9]*$' then (custom->>'lifeMonths')::integer
         else useful_life_months
       end,
       depreciation_rate_percent = case
         when custom->>'ratePercent' ~ '^([0-9]+([.][0-9]*)?|[.][0-9]+)$' then (custom->>'ratePercent')::numeric(19,4)
         else depreciation_rate_percent
       end,
       depreciation_convention = case
         when custom->>'convention' in ('full_month', 'mid_month', 'half_year') then custom->>'convention'
         else depreciation_convention
       end,
       depreciation_units_total = case
         when custom->>'unitsTotal' ~ '^([0-9]+([.][0-9]*)?|[.][0-9]+)$'
              and (custom->>'unitsTotal')::numeric > 0 then (custom->>'unitsTotal')::numeric(19,4)
         else depreciation_units_total
       end,
       custom = custom - 'method' - 'lifeMonths' - 'ratePercent' - 'convention' - 'unitsTotal';

alter table depreciation_schedules
  drop constraint if exists depr_schedules_positive_life,
  drop constraint if exists depr_schedules_nonnegative_rate,
  drop constraint if exists depr_schedules_positive_units;
alter table depreciation_schedules
  add constraint depr_schedules_positive_life check (life_months is null or life_months > 0),
  add constraint depr_schedules_nonnegative_rate check (rate_percent is null or rate_percent >= 0),
  add constraint depr_schedules_positive_units check (units_total is null or units_total > 0);

create unique index if not exists depr_schedules_org_asset_book
  on depreciation_schedules(org_id, asset_id, book_id);

create table if not exists depreciation_inputs (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  schedule_id uuid not null,
  period_id uuid not null,
  kind text not null check (kind in ('manual', 'production_usage')),
  manual_amount numeric(19,4),
  production_units numeric(19,4),
  memo text not null,
  evidence_reference text not null,
  supersedes_input_id uuid,
  voided_at timestamptz,
  voided_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint depr_inputs_kind_value check (
    (kind = 'manual' and manual_amount is not null and manual_amount <> 0 and production_units is null)
    or (kind = 'production_usage' and production_units is not null and production_units <> 0 and manual_amount is null)
  ),
  constraint depr_inputs_evidence_required check (length(btrim(memo)) > 0 and length(btrim(evidence_reference)) > 0)
);

alter table depreciation_inputs
  drop constraint if exists depr_inputs_kind_value;
alter table depreciation_inputs
  add constraint depr_inputs_kind_value check (
    (kind = 'manual' and manual_amount is not null and manual_amount <> 0 and production_units is null)
    or (kind = 'production_usage' and production_units is not null and production_units <> 0 and manual_amount is null)
  );

alter table depreciation_inputs enable row level security;
alter table depreciation_inputs force row level security;
drop policy if exists org_isolation on depreciation_inputs;
create policy org_isolation on depreciation_inputs
  using (current_setting('app.bypass_rls', true) = 'on'
         or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on'
              or org_id::text = current_setting('app.current_org', true));

create index if not exists depr_inputs_schedule_period on depreciation_inputs(schedule_id, period_id);
create index if not exists depr_inputs_org_active on depreciation_inputs(org_id, schedule_id, voided_at);
drop index if exists depr_inputs_one_active_period;

alter table depreciation_schedule_lines
  drop constraint if exists depr_lines_source_check,
  drop constraint if exists depr_lines_nonnegative_amounts,
  drop constraint if exists depr_lines_amount_direction,
  drop constraint if exists depr_lines_posting_evidence_pair,
  drop constraint if exists depr_lines_input_provenance;
alter table depreciation_schedule_lines
  add column if not exists source text not null default 'formula',
  add column if not exists input_id uuid;

-- Source-owned opening depreciation is posted in the source register but its
-- GL was imported independently by the native transaction connector. Preserve
-- that carrying-value evidence without manufacturing a duplicate local journal.
update depreciation_schedule_lines l
   set source = 'imported'
  from depreciation_schedules s
  join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
 where l.schedule_id = s.id
   and l.posted_amount is not null
   and l.journal_entry_id is null
   and coalesce((a.custom->>'sourceManaged')::boolean, false);

alter table depreciation_schedule_lines
  add constraint depr_lines_source_check check (source in ('formula', 'manual', 'production_usage', 'imported')),
  add constraint depr_lines_amount_direction
    check (source in ('manual', 'production_usage')
      or (planned_amount >= 0 and (posted_amount is null or posted_amount >= 0))),
  add constraint depr_lines_posting_evidence_pair
    check ((posted_amount is null and journal_entry_id is null)
      or (posted_amount is not null and (posted_amount = 0 or journal_entry_id is not null or source = 'imported'))),
  add constraint depr_lines_input_provenance
    check ((source in ('formula', 'imported') and input_id is null)
      or (source in ('manual', 'production_usage') and input_id is not null));

drop index if exists depr_lines_org_schedule_period;
create unique index if not exists depr_lines_org_formula_period
  on depreciation_schedule_lines(org_id, schedule_id, period_id) where source = 'formula';

alter table depreciation_book_policies add column if not exists units_total numeric(19,4);
alter table depreciation_book_policies drop constraint if exists dep_book_policies_positive_units;
alter table depreciation_book_policies
  add constraint dep_book_policies_positive_units check (units_total is null or units_total > 0);

alter table depreciation_inputs
  drop constraint if exists depreciation_inputs_org_fk,
  drop constraint if exists depreciation_inputs_schedule_fk,
  drop constraint if exists depreciation_inputs_period_fk,
  drop constraint if exists depreciation_inputs_supersedes_fk,
  drop constraint if exists depreciation_inputs_voided_by_fk,
  drop constraint if exists depreciation_inputs_created_by_fk,
  drop constraint if exists depreciation_inputs_updated_by_fk;
alter table depreciation_inputs
  add constraint depreciation_inputs_org_fk foreign key (org_id) references orgs(id),
  add constraint depreciation_inputs_schedule_fk foreign key (schedule_id) references depreciation_schedules(id),
  add constraint depreciation_inputs_period_fk foreign key (period_id) references accounting_periods(id),
  add constraint depreciation_inputs_supersedes_fk foreign key (supersedes_input_id) references depreciation_inputs(id),
  add constraint depreciation_inputs_voided_by_fk foreign key (voided_by) references users(id),
  add constraint depreciation_inputs_created_by_fk foreign key (created_by) references users(id),
  add constraint depreciation_inputs_updated_by_fk foreign key (updated_by) references users(id);

alter table depreciation_schedule_lines drop constraint if exists depreciation_schedule_lines_input_fk;
alter table depreciation_schedule_lines
  add constraint depreciation_schedule_lines_input_fk foreign key (input_id) references depreciation_inputs(id);

create or replace function openbooks_guard_depreciation_evidence()
returns trigger language plpgsql as $$
declare
  posted boolean;
begin
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'depreciation input evidence is append-preserved';
  end if;

  select exists (
    select 1 from depreciation_schedule_lines
     where input_id = old.id and posted_amount is not null
  ) into posted;
  if posted then
    raise exception 'posted depreciation input evidence is immutable';
  end if;

  if old.voided_at is not null
     or new.voided_at is null
     or new.voided_by is null
     or new.org_id is distinct from old.org_id
     or new.schedule_id is distinct from old.schedule_id
     or new.period_id is distinct from old.period_id
     or new.kind is distinct from old.kind
     or new.manual_amount is distinct from old.manual_amount
     or new.production_units is distinct from old.production_units
     or new.memo is distinct from old.memo
     or new.evidence_reference is distinct from old.evidence_reference
     or new.supersedes_input_id is distinct from old.supersedes_input_id
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'depreciation input evidence may only be voided before posting';
  end if;
  return new;
end;
$$;

drop trigger if exists depreciation_input_evidence_guard on depreciation_inputs;
create trigger depreciation_input_evidence_guard
before update or delete on depreciation_inputs
for each row execute function openbooks_guard_depreciation_evidence();

create or replace function openbooks_validate_depreciation_line_input()
returns trigger language plpgsql as $$
declare
  input_row depreciation_inputs%rowtype;
  schedule_method text;
begin
  if new.source in ('formula', 'imported') then return new; end if;
  select * into input_row from depreciation_inputs where id = new.input_id;
  if not found
     or input_row.voided_at is not null
     or input_row.org_id <> new.org_id
     or input_row.schedule_id <> new.schedule_id
     or input_row.period_id <> new.period_id then
    raise exception 'depreciation line input evidence does not match its schedule and period';
  end if;
  select method into schedule_method from depreciation_schedules where id = new.schedule_id;
  if (new.source = 'manual' and (input_row.kind <> 'manual' or schedule_method <> 'manual'))
     or (new.source = 'production_usage' and (input_row.kind <> 'production_usage' or schedule_method <> 'units_of_production')) then
    raise exception 'depreciation line source does not match its method evidence';
  end if;
  return new;
end;
$$;

drop trigger if exists depreciation_line_input_guard on depreciation_schedule_lines;
create trigger depreciation_line_input_guard
before insert or update of schedule_id, period_id, source, input_id on depreciation_schedule_lines
for each row execute function openbooks_validate_depreciation_line_input();

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'openbooks_read') then
    grant select on depreciation_inputs to openbooks_read;
  end if;
end $$;
