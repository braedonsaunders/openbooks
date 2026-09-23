-- OpenBooks forward migration 0272_budget_pnl_calendar_scope.
--
-- Three budget-scope holes, all the same shape (a line the worksheet hides
-- but the totals count):
--
--   1. The line guard admitted every active non-summary account, including
--      balance-sheet types. The worksheet, the import, the variances and the
--      copy paths all plan the P&L only (the six types of the single PNL_TYPES
--      definition in engine records/account-types), so an imported
--      balance-sheet line was invisible yet counted. The guard now admits
--      P&L types only, refusing others by name.
--
--   2. The line guard admitted non-adjustment periods from ANY fiscal
--      calendar, while the worksheet reads the org default calendar only. A
--      line on a second calendar was hidden from the worksheet but counted in
--      totals. A budget is pinned to ONE calendar — the org default, the same
--      calendar the worksheet, the import resolver, the copy mapping and the
--      totals read — and the guard enforces it.
--
--   3. The scenario guard let a budget's book change under existing lines,
--      reinterpreting the whole plan against a different ledger (the fiscal
--      year already refused with lines at the API). Book and fiscal year are
--      now fixed once the scenario has lines, in the trigger as well as the
--      route, so writers bypassing the API meet the same refusal.
--
-- Additive enforcement only: no existing row is rewritten. Rows written
-- before this migration that violate the new checks stay readable; any
-- INSERT or UPDATE touching them meets the guard.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.openbooks_guard_budget_line() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
  -- Budgets plan the profit and loss only: the six P&L types of the single
  -- PNL_TYPES definition (engine records/account-types), the same set the
  -- worksheet, the import, the variances and the prior-actuals copy filter
  -- on. Refuse a balance-sheet account by name rather than writing a line
  -- the worksheet hides but the totals count.
  if not exists (
    select 1 from accounts a
     where a.id = new.account_id and a.org_id = new.org_id
       and a.type in ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred')
  ) then
    raise exception 'budget account must be a profit-and-loss posting account in the tenant (income, income_other, cogs, expense, expense_other, expense_deferred)';
  end if;
  if not exists (
    select 1 from accounting_periods p
     where p.id = new.period_id and p.org_id = new.org_id
       and p.fiscal_year = scenario_year and not p.is_adjustment
  ) then
    raise exception 'budget period must belong to the scenario fiscal year and tenant';
  end if;
  -- A budget is pinned to one calendar: the org default. The worksheet, the
  -- totals, the import resolver and the copy mapping all read that calendar,
  -- so a line on any other calendar would be hidden yet counted.
  if not exists (
    select 1 from accounting_periods p
      join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
     where p.id = new.period_id and p.org_id = new.org_id
       and p.fiscal_year = scenario_year and not p.is_adjustment and fc.is_default
  ) then
    raise exception 'budget period must belong to the scenario fiscal year on the default fiscal calendar of the tenant';
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

CREATE OR REPLACE FUNCTION public.openbooks_guard_budget_scenario() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
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
    -- The book and fiscal year pin the plan to one ledger and one period
    -- set: changing either under existing lines would silently reinterpret
    -- the whole plan. Refuse here as well as in the route so writers
    -- bypassing the API meet the same refusal.
    if (new.book_id is distinct from old.book_id or new.fiscal_year is distinct from old.fiscal_year)
       and exists (select 1 from budget_lines bl where bl.scenario_id = new.id and bl.org_id = new.org_id)
    then
      raise exception 'budget book and fiscal year are fixed once the budget has lines';
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
