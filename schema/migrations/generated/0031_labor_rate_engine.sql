-- Effective-dated labor costing, billing, transfer pricing, immutable approval
-- snapshots, and payroll actual-to-standard reconciliation.

alter table item_rate_book_assignments drop constraint if exists item_rate_assignment_one_scope;
alter table item_rate_book_assignments add column if not exists name text;
alter table item_rate_book_assignments add column if not exists project_task_id uuid;
alter table item_rate_book_assignments add column if not exists subsidiary_id uuid;
alter table item_rate_book_assignments add column if not exists department_id uuid;
alter table item_rate_book_assignments add column if not exists location_id uuid;
alter table item_rate_book_assignments add column if not exists priority integer not null default 0;

alter table projects add column if not exists labor_rate_book_id uuid;
alter table projects add column if not exists labor_rate_policy text;
alter table projects add column if not exists labor_rate_locked_version_id uuid;
alter table projects add column if not exists labor_rate_lock_date date;
alter table projects drop constraint if exists projects_labor_rate_policy_check;
alter table projects add constraint projects_labor_rate_policy_check
  check (labor_rate_policy in ('work_date','locked','scheduled_escalation','manual_reprice'));
alter table project_types add column if not exists labor_rate_book_id uuid;
alter table project_types add column if not exists labor_rate_policy text;
alter table project_types drop constraint if exists project_types_labor_rate_policy_check;
alter table project_types add constraint project_types_labor_rate_policy_check
  check (labor_rate_policy in ('work_date','locked','scheduled_escalation','manual_reprice'));

alter table time_types add column if not exists bill_multiplier numeric(19,4) not null default 1;
alter table time_types drop constraint if exists time_types_bill_multiplier_check;
alter table time_types add constraint time_types_bill_multiplier_check check (bill_multiplier >= 0);

alter table time_entries add column if not exists location_id uuid;
alter table time_entries add column if not exists direct_cost_rate numeric(19,4);
alter table time_entries add column if not exists burden_rate numeric(19,4);
alter table time_entries add column if not exists transfer_rate numeric(19,4);
alter table time_entries add column if not exists standard_cost_amount numeric(19,4);
alter table time_entries add column if not exists actual_cost_amount numeric(19,4);
alter table time_entries add column if not exists cost_variance_amount numeric(19,4);
alter table time_entries add column if not exists cost_rate_version_id uuid;
alter table time_entries add column if not exists bill_rate_version_id uuid;
alter table time_entries add column if not exists rate_resolved_at timestamptz;
alter table time_entries add column if not exists rate_resolution_hash text;

create table labor_classes (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, code text not null, name text not null,
  parent_id uuid, is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);
create unique index labor_classes_org_code on labor_classes (org_id, code);
create index labor_classes_parent on labor_classes (org_id, parent_id);

create table employee_labor_class_assignments (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, employee_party_id uuid not null,
  labor_class_id uuid not null, effective_from date not null, effective_to date,
  is_primary boolean not null default true, is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint employee_labor_class_valid_range check (effective_to is null or effective_to >= effective_from)
);
create index employee_labor_class_employee_date on employee_labor_class_assignments (org_id, employee_party_id, effective_from, effective_to);
create unique index employee_labor_class_from on employee_labor_class_assignments (employee_party_id, labor_class_id, effective_from);

create table employee_compensation_rates (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, employee_party_id uuid not null,
  amount numeric(19,4) not null, currency text not null, basis text not null default 'hour',
  annual_hours numeric(19,4) not null default 2080, effective_from date not null, effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint employee_compensation_basis check (basis in ('hour','year')),
  constraint employee_compensation_nonnegative check (amount >= 0),
  constraint employee_compensation_annual_hours check (annual_hours > 0),
  constraint employee_compensation_valid_range check (effective_to is null or effective_to >= effective_from)
);
create index employee_compensation_employee_date on employee_compensation_rates (org_id, employee_party_id, effective_from, effective_to);
create unique index employee_compensation_from on employee_compensation_rates (employee_party_id, effective_from);

create table labor_rate_lines (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, version_id uuid not null,
  code text not null, name text not null, lane text not null, method text not null default 'fixed',
  amount numeric(19,4), percent numeric(19,4), currency text not null, unit_code text not null default 'hour',
  base_hours numeric(19,4) not null default 1, employee_party_id uuid, labor_class_id uuid, item_id uuid,
  time_type_id uuid, subsidiary_id uuid, department_id uuid, location_id uuid, worker_comp_group_id uuid,
  priority integer not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint labor_rate_lines_lane check (lane in ('direct_cost','bill','transfer','planning_cost','planning_bill')),
  constraint labor_rate_lines_method check (method in ('fixed','at_cost','markup_on_cost','margin_on_cost')),
  constraint labor_rate_lines_base_hours check (base_hours > 0),
  constraint labor_rate_lines_amount check (amount is null or amount >= 0),
  constraint labor_rate_lines_percent check (percent is null or percent >= 0),
  constraint labor_rate_lines_method_value check (
    (method = 'fixed' and amount is not null and percent is null)
    or (method = 'at_cost' and amount is null and percent is null)
    or (method = 'markup_on_cost' and amount is null and percent is not null)
    or (method = 'margin_on_cost' and amount is null and percent is not null and percent < 100)
  )
);
create unique index labor_rate_lines_version_code on labor_rate_lines (version_id, code);
create index labor_rate_lines_match on labor_rate_lines (org_id, version_id, lane, item_id, time_type_id);

create table labor_rate_components (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, version_id uuid not null,
  code text not null, name text not null, lane text not null default 'cost', method text not null,
  value numeric(19,4) not null, currency text, employee_party_id uuid, labor_class_id uuid, item_id uuid,
  time_type_id uuid, subsidiary_id uuid, department_id uuid, location_id uuid, worker_comp_group_id uuid,
  sequence integer not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint labor_rate_components_lane check (lane in ('cost','bill','transfer')),
  constraint labor_rate_components_method check (method in ('fixed_per_hour','percent_of_base_direct','percent_of_direct','percent_of_subtotal')),
  constraint labor_rate_components_nonnegative check (value >= 0),
  constraint labor_rate_components_currency check (method <> 'fixed_per_hour' or currency is not null)
);
create unique index labor_rate_components_version_code on labor_rate_components (version_id, code);
create index labor_rate_components_match on labor_rate_components (org_id, version_id, lane, sequence);

create table time_entry_rate_components (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, time_entry_id uuid not null,
  lane text not null, source_line_id uuid, source_component_id uuid, code text not null, name text not null,
  method text not null, source_currency text not null, fx_rate numeric(19,10) not null default 1,
  rate_per_hour numeric(19,4) not null, amount numeric(19,4) not null, sequence integer not null,
  explanation text not null, created_at timestamptz not null default now(), created_by uuid,
  constraint time_entry_rate_components_lane check (lane in ('direct_cost','burden','bill','transfer'))
);
create unique index time_entry_rate_components_sequence on time_entry_rate_components (time_entry_id, lane, sequence);
create index time_entry_rate_components_entry on time_entry_rate_components (org_id, time_entry_id);

create table external_payroll_sources (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, code text not null, name text not null,
  accounting_mode text not null default 'variance_to_clearing', payroll_clearing_account_id uuid,
  require_posted_journal boolean not null default true, is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint external_payroll_sources_accounting_mode check (accounting_mode in ('costing_only','variance_to_clearing'))
);
create unique index external_payroll_sources_org_code on external_payroll_sources (org_id, code);

create table external_payroll_import_templates (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, source_id uuid not null, code text not null,
  name text not null, external_line_id_column text not null default 'externalLineId',
  employee_code_column text not null default 'employeePartyId', component_column text not null default 'component',
  amount_column text not null default 'amount', pay_code_column text, hours_column text, memo_column text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);
create unique index external_payroll_import_templates_source_code on external_payroll_import_templates (source_id, code);
create index external_payroll_import_templates_org on external_payroll_import_templates (org_id, source_id);

create table payroll_cost_batches (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, source_id uuid not null, subsidiary_id uuid not null, code text not null,
  external_batch_id text not null,
  period_start date not null, period_end date not null, posting_date date not null, currency text not null,
  status text not null default 'draft', actual_total numeric(19,4) not null default 0,
  actual_total_base numeric(19,4) not null default 0, variance_total numeric(19,4) not null default 0,
  source_journal_document_id uuid, variance_journal_entry_id uuid, exception_count integer not null default 0,
  validation_errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint payroll_cost_batches_status check (status in ('draft','validated','reconciled','posted')),
  constraint payroll_cost_batches_range check (period_end >= period_start)
);
create unique index payroll_cost_batches_org_code on payroll_cost_batches (org_id, code);
create unique index payroll_cost_batches_source_external on payroll_cost_batches (source_id, external_batch_id);

create table payroll_cost_lines (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, batch_id uuid not null,
  external_line_id text not null, employee_party_id uuid not null, pay_code text, component text not null,
  hours numeric(19,4), amount numeric(19,4) not null, memo text,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint payroll_cost_lines_component check (component in ('gross_pay','employer_tax','benefit','worker_comp','other')),
  constraint payroll_cost_lines_hours_nonnegative check (hours is null or hours >= 0)
);
create unique index payroll_cost_lines_batch_external on payroll_cost_lines (batch_id, external_line_id);
create index payroll_cost_lines_batch_employee on payroll_cost_lines (org_id, batch_id, employee_party_id);

create table payroll_time_allocations (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, payroll_line_id uuid not null,
  time_entry_id uuid not null, project_id uuid, project_task_id uuid, department_id uuid, location_id uuid,
  allocated_amount numeric(19,4) not null,
  standard_amount numeric(19,4) not null, variance_amount numeric(19,4) not null,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);
create unique index payroll_time_allocations_line_time on payroll_time_allocations (payroll_line_id, time_entry_id);
create index payroll_time_allocations_project on payroll_time_allocations (org_id, project_id);

-- Foreign keys are maintained in referential-integrity.sql.

create or replace function labor_rate_snapshot_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'approved-time rate explanations are immutable';
end $$;
create trigger time_entry_rate_components_append_only before update or delete on time_entry_rate_components
  for each row execute function labor_rate_snapshot_immutable();

create or replace function rate_version_immutable() returns trigger language plpgsql as $$
begin
  if old.status in ('active','retired') then
    if old.status = 'active' and new.status = 'active'
       and new.rate_book_id = old.rate_book_id and new.effective_from = old.effective_from
       and new.effective_to is not null and new.effective_to >= old.effective_from
       and (old.effective_to is null or new.effective_to <= old.effective_to) then return new; end if;
    if old.status = 'active' and new.status = 'retired'
       and new.rate_book_id = old.rate_book_id and new.effective_from = old.effective_from
       and new.effective_to is not distinct from old.effective_to then return new; end if;
    raise exception 'activated and retired rate versions are immutable';
  end if;
  return new;
end $$;
create trigger item_rate_versions_immutable before update on item_rate_versions
  for each row execute function rate_version_immutable();

create or replace function rate_version_child_guard() returns trigger language plpgsql as $$
declare version_status text;
begin
  select status into version_status from item_rate_versions where id = coalesce(new.version_id, old.version_id);
  if version_status <> 'draft' then raise exception 'rate lines in an activated or retired version are immutable'; end if;
  return coalesce(new, old);
end $$;
create trigger item_rate_lines_version_guard before insert or update or delete on item_rate_lines for each row execute function rate_version_child_guard();
create trigger labor_rate_lines_version_guard before insert or update or delete on labor_rate_lines for each row execute function rate_version_child_guard();
create trigger labor_rate_components_version_guard before insert or update or delete on labor_rate_components for each row execute function rate_version_child_guard();

create or replace function payroll_posted_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or openbooks_sandbox_wipe_allowed(old.org_id) then return old; end if;
    raise exception 'validated, reconciled, and posted external payroll batches are immutable';
  end if;
  if old.status = 'posted' then raise exception 'posted external payroll cost batch % is immutable', old.id; end if;
  if old.status = 'reconciled' and new.status <> 'posted' then
    raise exception 'a reconciled external payroll batch can only be posted';
  end if;
  if old.status = 'reconciled' and
     (to_jsonb(new) - array['status','variance_journal_entry_id','updated_at','updated_by']) <>
     (to_jsonb(old) - array['status','variance_journal_entry_id','updated_at','updated_by']) then
    raise exception 'reconciled external payroll evidence is immutable';
  end if;
  return new;
end $$;
create trigger payroll_cost_batches_posted_guard before update or delete on payroll_cost_batches
  for each row execute function payroll_posted_guard();

create or replace function payroll_cost_line_draft_guard() returns trigger language plpgsql as $$
declare batch_status text;
begin
  select status into batch_status from payroll_cost_batches where id = coalesce(new.batch_id, old.batch_id);
  if batch_status <> 'draft' then raise exception 'external payroll cost lines are immutable after validation'; end if;
  return coalesce(new, old);
end $$;
create trigger payroll_cost_lines_draft_guard before insert or update or delete on payroll_cost_lines
  for each row execute function payroll_cost_line_draft_guard();

create or replace function payroll_allocation_guard() returns trigger language plpgsql as $$
declare batch_status text;
begin
  select b.status into batch_status
    from payroll_cost_lines l join payroll_cost_batches b on b.id = l.batch_id
   where l.id = coalesce(new.payroll_line_id, old.payroll_line_id);
  if batch_status not in ('draft','validated') then
    raise exception 'external payroll allocations are immutable after reconciliation';
  end if;
  return coalesce(new, old);
end $$;
create trigger payroll_time_allocations_guard before insert or update or delete on payroll_time_allocations
  for each row execute function payroll_allocation_guard();

do $$
declare table_name text; policy_body text := $policy$(current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))$policy$;
begin
  foreach table_name in array array['labor_classes','employee_labor_class_assignments','employee_compensation_rates','labor_rate_lines','labor_rate_components','time_entry_rate_components','external_payroll_sources','external_payroll_import_templates','payroll_cost_batches','payroll_cost_lines','payroll_time_allocations'] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', table_name, policy_body, policy_body);
  end loop;
end $$;

grant select on labor_classes, employee_labor_class_assignments, employee_compensation_rates,
  labor_rate_lines, labor_rate_components, time_entry_rate_components,
  external_payroll_sources, external_payroll_import_templates,
  payroll_cost_batches, payroll_cost_lines, payroll_time_allocations to openbooks_read;
