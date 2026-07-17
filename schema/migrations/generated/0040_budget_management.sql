-- Production budget authoring: governed scenarios, exact dimensional cells,
-- tenant integrity, optimistic concurrency, and immutable approved versions.

alter table budget_scenarios
  add column description text,
  add column revision integer not null default 1,
  add column submitted_at timestamptz,
  add column submitted_by uuid,
  add column approved_at timestamptz,
  add column approved_by uuid;

alter table budget_scenarios
  add constraint budget_scenarios_kind_check check (kind in ('budget', 'forecast')),
  add constraint budget_scenarios_status_check check (status in ('draft', 'pending_approval', 'approved', 'archived')),
  add constraint budget_scenarios_fiscal_year_check check (fiscal_year between 1900 and 9999),
  add constraint budget_scenarios_name_check check (length(btrim(name)) between 1 and 200),
  add constraint budget_scenarios_revision_check check (revision > 0),
  add constraint budget_scenarios_identity unique (org_id, book_id, fiscal_year, kind, name);

create index budget_scenarios_org_year_status
  on budget_scenarios (org_id, fiscal_year, status);

-- Collapse any duplicate cells admitted by PostgreSQL's default NULL-distinct
-- uniqueness before replacing the old index with the correct constraint.
with ranked as (
  select id,
         row_number() over (
           partition by scenario_id, account_id, period_id,
                        department_id, project_id, location_id, class_id
           order by created_at, id
         ) as rn,
         sum(amount) over (
           partition by scenario_id, account_id, period_id,
                        department_id, project_id, location_id, class_id
         ) as merged_amount
    from budget_lines
)
update budget_lines bl
   set amount = ranked.merged_amount, updated_at = now()
  from ranked
 where bl.id = ranked.id and ranked.rn = 1;

with ranked as (
  select id,
         row_number() over (
           partition by scenario_id, account_id, period_id,
                        department_id, project_id, location_id, class_id
           order by created_at, id
         ) as rn
    from budget_lines
)
delete from budget_lines bl using ranked
 where bl.id = ranked.id and ranked.rn > 1;

drop index if exists budget_lines_cell;
alter table budget_lines add constraint budget_lines_cell
  unique nulls not distinct
  (scenario_id, account_id, period_id, department_id, project_id, location_id, class_id);
create index budget_lines_org_scenario on budget_lines (org_id, scenario_id);

-- Incremental FK coverage. Fresh rebuilds receive these here too; the planning
-- block in referential-integrity.sql intentionally defers to this migration.
alter table budget_scenarios
  add constraint budget_scenarios_org_fk foreign key (org_id) references orgs(id) on delete cascade,
  add constraint budget_scenarios_submitted_by_fk foreign key (submitted_by) references users(id),
  add constraint budget_scenarios_approved_by_fk foreign key (approved_by) references users(id);
alter table budget_lines
  add constraint budget_lines_org_fk foreign key (org_id) references orgs(id) on delete cascade,
  add constraint budget_lines_department_fk foreign key (department_id) references departments(id),
  add constraint budget_lines_project_fk foreign key (project_id) references projects(id),
  add constraint budget_lines_location_fk foreign key (location_id) references locations(id),
  add constraint budget_lines_class_fk foreign key (class_id) references classes(id);

alter table budget_lines drop constraint if exists budget_lines_scenario_id_fkey;
alter table budget_lines add constraint budget_lines_scenario_fk
  foreign key (scenario_id) references budget_scenarios(id) on delete cascade;

create or replace function openbooks_guard_budget_scenario()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and not openbooks_sandbox_wipe_allowed(old.org_id) then
      raise exception 'only draft budget scenarios may be deleted';
    end if;
    return old;
  end if;

  if not exists (
    select 1 from accounting_books b
     where b.id = new.book_id and b.org_id = new.org_id and b.is_active
  ) then
    raise exception 'budget scenario book must be active and belong to the tenant';
  end if;

  if tg_op = 'UPDATE' then
    if new.revision <> old.revision + 1 then
      raise exception 'budget scenario revision must increment by exactly one';
    end if;
    if old.status <> 'draft' and (
      new.name is distinct from old.name or
      new.description is distinct from old.description or
      new.book_id is distinct from old.book_id or
      new.fiscal_year is distinct from old.fiscal_year or
      new.kind is distinct from old.kind
    ) then
      raise exception 'only draft budget metadata may be edited';
    end if;
    if new.status is distinct from old.status and not (
      (old.status = 'draft' and new.status in ('pending_approval', 'archived')) or
      (old.status = 'pending_approval' and new.status in ('draft', 'approved', 'archived')) or
      (old.status = 'approved' and new.status = 'archived')
    ) then
      raise exception 'invalid budget status transition: % -> %', old.status, new.status;
    end if;
  end if;

  if new.status in ('pending_approval', 'approved') and not exists (
    select 1 from budget_lines bl
     where bl.scenario_id = new.id and bl.org_id = new.org_id and bl.amount <> 0
  ) then
    raise exception 'a submitted or approved budget must contain at least one non-zero line';
  end if;
  if new.submitted_by is not null and not exists (
    select 1 from users u where u.id = new.submitted_by and u.org_id = new.org_id
  ) then raise exception 'budget submitter must belong to the tenant'; end if;
  if new.approved_by is not null and not exists (
    select 1 from users u where u.id = new.approved_by and u.org_id = new.org_id
  ) then raise exception 'budget approver must belong to the tenant'; end if;
  return new;
end;
$$;

drop trigger if exists budget_scenario_guard on budget_scenarios;
create trigger budget_scenario_guard
before insert or update or delete on budget_scenarios
for each row execute function openbooks_guard_budget_scenario();

create or replace function openbooks_guard_budget_line()
returns trigger language plpgsql as $$
declare
  row_data budget_lines%rowtype;
  scenario_org uuid;
  scenario_year integer;
  scenario_status text;
begin
  row_data := case when tg_op = 'DELETE' then old else new end;
  select org_id, fiscal_year, status
    into scenario_org, scenario_year, scenario_status
    from budget_scenarios where id = row_data.scenario_id;
  -- During an ON DELETE CASCADE, PostgreSQL removes the parent scenario before
  -- firing the child row's delete trigger. The line was already protected by
  -- the scenario's draft-only delete guard, so allow that cascade to finish.
  if tg_op = 'DELETE' and scenario_org is null then return old; end if;
  if scenario_org is null or scenario_org <> row_data.org_id then
    raise exception 'budget line scenario must belong to the tenant';
  end if;
  if scenario_status <> 'draft' then
    raise exception 'budget lines are immutable outside draft status';
  end if;
  if tg_op = 'DELETE' then return old; end if;

  if not exists (
    select 1 from accounts a
     where a.id = new.account_id and a.org_id = new.org_id and a.is_active and not a.is_summary
  ) then
    raise exception 'budget account must be an active posting account in the tenant';
  end if;
  if not exists (
    select 1 from accounting_periods p
     where p.id = new.period_id and p.org_id = new.org_id
       and p.fiscal_year = scenario_year and not p.is_adjustment
  ) then
    raise exception 'budget period must belong to the scenario fiscal year and tenant';
  end if;
  if new.department_id is not null and not exists (
    select 1 from departments d where d.id = new.department_id and d.org_id = new.org_id
  ) then raise exception 'budget department must belong to the tenant'; end if;
  if new.project_id is not null and not exists (
    select 1 from projects p where p.id = new.project_id and p.org_id = new.org_id
  ) then raise exception 'budget project must belong to the tenant'; end if;
  if new.location_id is not null and not exists (
    select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id
  ) then raise exception 'budget location must belong to the tenant'; end if;
  if new.class_id is not null and not exists (
    select 1 from classes c where c.id = new.class_id and c.org_id = new.org_id
  ) then raise exception 'budget class must belong to the tenant'; end if;
  return new;
end;
$$;

drop trigger if exists budget_line_guard on budget_lines;
create trigger budget_line_guard
before insert or update or delete on budget_lines
for each row execute function openbooks_guard_budget_line();

grant select on budget_scenarios, budget_lines to openbooks_read;
