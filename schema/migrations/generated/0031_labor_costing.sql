-- Labor costing: ONE effective-dated wage table (labor_cost_rates).
-- Doctrine: wage = real GL job cost (standard anticipating payroll actuals);
-- estimated statutory burden = calculator components in orgs.settings
-- (laborCosting), no tables; overhead = separate statistical layer.
--
-- Also drops the reverted labor-rate-engine schema (commit 9ff64c1, reverted
-- baaac59) from any environment where its migration ran before the revert.

-- ---- cleanup: reverted labor-rate engine (no-ops where never applied) ----
drop table if exists payroll_time_allocations;
drop table if exists payroll_cost_lines;
drop table if exists payroll_cost_batches;
drop table if exists external_payroll_import_templates;
drop table if exists external_payroll_sources;
drop table if exists time_entry_rate_components;
drop table if exists labor_rate_components;
drop table if exists labor_rate_lines;
drop table if exists employee_compensation_rates;
drop table if exists employee_labor_class_assignments;
drop table if exists labor_classes;

alter table time_entries
  drop column if exists location_id,
  drop column if exists direct_cost_rate,
  drop column if exists burden_rate,
  drop column if exists transfer_rate,
  drop column if exists standard_cost_amount,
  drop column if exists actual_cost_amount,
  drop column if exists cost_variance_amount,
  drop column if exists cost_rate_version_id,
  drop column if exists bill_rate_version_id,
  drop column if exists rate_resolved_at,
  drop column if exists rate_resolution_hash;

alter table projects
  drop column if exists labor_rate_locked_version_id,
  drop column if exists labor_rate_lock_date;

-- ---- labor_cost_rates ----------------------------------------------------
create table if not exists labor_cost_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  employee_party_id uuid,
  trade_id uuid,
  rate numeric(19, 4) not null,
  basis text not null default 'hour',
  annual_hours numeric(19, 4) not null default 2080,
  effective_from date not null,
  effective_to date,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint labor_cost_rates_basis check (basis in ('hour', 'year')),
  constraint labor_cost_rates_nonnegative check (rate >= 0),
  constraint labor_cost_rates_annual_hours check (annual_hours > 0),
  constraint labor_cost_rates_valid_range check (effective_to is null or effective_to >= effective_from),
  constraint labor_cost_rates_one_scope check (not (employee_party_id is not null and trade_id is not null))
);

create index if not exists labor_cost_rates_employee
  on labor_cost_rates (org_id, employee_party_id, effective_from);
create index if not exists labor_cost_rates_trade
  on labor_cost_rates (org_id, trade_id, effective_from);
-- One row per scope per start date (nulls coalesced so the org default and
-- each trade/employee scope each get at most one row per effective_from).
create unique index if not exists labor_cost_rates_scope_from
  on labor_cost_rates (
    org_id,
    coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid),
    effective_from
  );

-- Tenant isolation (same forced org_isolation policy as every org table).
alter table labor_cost_rates enable row level security;
alter table labor_cost_rates force row level security;
drop policy if exists org_isolation on labor_cost_rates;
create policy org_isolation on labor_cost_rates
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true)
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true)
  );
