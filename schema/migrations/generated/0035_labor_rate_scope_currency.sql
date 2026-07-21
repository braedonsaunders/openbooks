-- Expand labor wage scopes and preserve each rate's denomination.

alter table employee_roles
  add column if not exists job_title text;

alter table time_entries
  add column if not exists labor_cost_rate_id uuid,
  add column if not exists wage_rate numeric(19, 4),
  add column if not exists wage_currency text,
  add column if not exists wage_fx_rate numeric(19, 10),
  add column if not exists cost_rate_currency text,
  add column if not exists cost_rate_subsidiary_id uuid;

alter table labor_cost_rates
  add column if not exists job_title text,
  add column if not exists department_id uuid,
  add column if not exists subsidiary_id uuid,
  add column if not exists currency text;

-- Existing rates were implicitly denominated in the organization base currency.
update labor_cost_rates r
   set currency = o.base_currency
  from orgs o
 where o.id = r.org_id and r.currency is null;

alter table labor_cost_rates
  alter column currency set not null;

alter table labor_cost_rates
  drop constraint if exists labor_cost_rates_one_scope,
  add constraint labor_cost_rates_one_scope
    check (num_nonnulls(employee_party_id, job_title, trade_id, department_id, subsidiary_id) <= 1);

drop index if exists labor_cost_rates_scope_from;
create unique index labor_cost_rates_scope_from
  on labor_cost_rates (
    org_id,
    coalesce(employee_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lower(job_title), ''),
    coalesce(trade_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
    effective_from
  );

create index if not exists labor_cost_rates_job_title
  on labor_cost_rates (org_id, job_title, effective_from);
create index if not exists labor_cost_rates_department
  on labor_cost_rates (org_id, department_id, effective_from);
create index if not exists labor_cost_rates_subsidiary
  on labor_cost_rates (org_id, subsidiary_id, effective_from);

-- Foreign keys live in the authoritative referential-integrity.sql map.
