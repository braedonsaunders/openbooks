-- Effective-dated financial configuration overlap guards.
--
-- These are scoped by the exact business dimensions that determine lookup
-- identity. Identical date ranges are allowed when they are genuinely different
-- policies (different tax code, labor scope, overhead department/rate kind,
-- rate book, customer/project assignment, item/currency SSP, or ownership path).
-- Active=false/draft/retired rows are excluded where the domain uses lifecycle
-- state so historical drafts and retired rows do not block new policy rows.

create or replace function effective_date_ranges_overlap(
  a_from date,
  a_to date,
  b_from date,
  b_to date
) returns boolean
language sql immutable as $$
  select daterange(a_from, coalesce(a_to, 'infinity'::date), '[]')
      && daterange(b_from, coalesce(b_to, 'infinity'::date), '[]')
$$;

-- ---------------------------------------------------------------------------
-- Tax rates: one active rate schedule per tax code.
-- Distinctions: tax_code_id already encodes jurisdiction, sales/purchase usage,
-- recoverability, withholding/reverse-charge behavior, and control accounts.
-- ---------------------------------------------------------------------------
create or replace function tax_rates_no_overlap_guard() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1
      from tax_rates r
     where r.id <> new.id
       and r.org_id = new.org_id
       and r.tax_code_id = new.tax_code_id
       and effective_date_ranges_overlap(r.effective_from, r.effective_to, new.effective_from, new.effective_to)
  ) then
    raise exception 'tax rates overlap for tax code %', new.tax_code_id using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists tax_rates_no_overlap on tax_rates;
create trigger tax_rates_no_overlap
  before insert or update of org_id, tax_code_id, effective_from, effective_to
  on tax_rates
  for each row execute function tax_rates_no_overlap_guard();

-- Tax registrations: one active registration window per jurisdiction/form pair.
-- Distinctions: same jurisdiction can have separate returns/forms when required.
create or replace function tax_registrations_no_overlap_guard() returns trigger
language plpgsql as $$
begin
  if not new.is_active then return new; end if;
  if exists (
    select 1
      from tax_registrations r
     where r.id <> new.id
       and r.org_id = new.org_id
       and r.is_active
       and r.jurisdiction_id = new.jurisdiction_id
       and coalesce(r.return_form_code, '') = coalesce(new.return_form_code, '')
       and effective_date_ranges_overlap(coalesce(r.effective_from, '-infinity'::date), r.effective_to, coalesce(new.effective_from, '-infinity'::date), new.effective_to)
  ) then
    raise exception 'tax registrations overlap for jurisdiction % and return form %', new.jurisdiction_id, coalesce(new.return_form_code, '') using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists tax_registrations_no_overlap on tax_registrations;
create trigger tax_registrations_no_overlap
  before insert or update of org_id, jurisdiction_id, return_form_code, effective_from, effective_to, is_active
  on tax_registrations
  for each row execute function tax_registrations_no_overlap_guard();

-- ---------------------------------------------------------------------------
-- Labor cost wage rates: one active row per exact wage-resolution scope.
-- Distinctions: employee/job title/trade/department/subsidiary/org default are
-- independent scopes. The table's one-scope check keeps these mutually exclusive,
-- but the overlap key intentionally includes every nullable scope column.
-- ---------------------------------------------------------------------------
create or replace function labor_cost_rates_no_overlap_guard() returns trigger
language plpgsql as $$
begin
  if not new.is_active then return new; end if;
  if exists (
    select 1
      from labor_cost_rates r
     where r.id <> new.id
       and r.org_id = new.org_id
       and r.is_active
       and r.employee_party_id is not distinct from new.employee_party_id
       and lower(coalesce(r.job_title, '')) = lower(coalesce(new.job_title, ''))
       and r.trade_id is not distinct from new.trade_id
       and r.department_id is not distinct from new.department_id
       and r.subsidiary_id is not distinct from new.subsidiary_id
       and effective_date_ranges_overlap(r.effective_from, r.effective_to, new.effective_from, new.effective_to)
  ) then
    raise exception 'labor cost rates overlap for the same wage scope' using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists labor_cost_rates_no_overlap on labor_cost_rates;
create trigger labor_cost_rates_no_overlap
  before insert or update of org_id, employee_party_id, job_title, trade_id, department_id, subsidiary_id, effective_from, effective_to, is_active
  on labor_cost_rates
  for each row execute function labor_cost_rates_no_overlap_guard();

-- ---------------------------------------------------------------------------
-- Overhead absorption rates: one active row per department/category/method/kind.
-- Distinctions: department null = organization default; department-specific rows
-- can share date ranges with the org default and will win by specificity. Rate
-- kind and category/method are distinct policies and may coexist.
-- ---------------------------------------------------------------------------
create or replace function overhead_rates_no_overlap_guard() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1
      from overhead_rates r
     where r.id <> new.id
       and r.org_id = new.org_id
       and r.department_id is not distinct from new.department_id
       and coalesce(lower(r.category), '') = coalesce(lower(new.category), '')
       and r.method = new.method
       and r.rate_kind = new.rate_kind
       and effective_date_ranges_overlap(r.effective_from, r.effective_to, new.effective_from, new.effective_to)
  ) then
    raise exception 'overhead rates overlap for the same department/category/method/rate kind scope' using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists overhead_rates_no_overlap on overhead_rates;
create trigger overhead_rates_no_overlap
  before insert or update of org_id, department_id, category, method, rate_kind, effective_from, effective_to
  on overhead_rates
  for each row execute function overhead_rates_no_overlap_guard();

-- ---------------------------------------------------------------------------
-- Item/commercial rate versions: one active version per rate book and date.
-- Distinctions: different rate books can have identical ranges; a customer or
-- project assignment chooses the book before version resolution.
-- ---------------------------------------------------------------------------
create or replace function item_rate_versions_no_overlap_guard() returns trigger
language plpgsql as $$
begin
  if new.status <> 'active' then return new; end if;
  if exists (
    select 1
      from item_rate_versions v
     where v.id <> new.id
       and v.org_id = new.org_id
       and v.rate_book_id = new.rate_book_id
       and v.status = 'active'
       and effective_date_ranges_overlap(v.effective_from, v.effective_to, new.effective_from, new.effective_to)
  ) then
    raise exception 'active item rate versions overlap for rate book %', new.rate_book_id using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists item_rate_versions_no_overlap on item_rate_versions;
create trigger item_rate_versions_no_overlap
  before insert or update of org_id, rate_book_id, effective_from, effective_to, status
  on item_rate_versions
  for each row execute function item_rate_versions_no_overlap_guard();

-- Rate-book assignments: one active assignment per exact assignment scope.
-- Distinctions: customer, project, department, subsidiary, location, class,
-- rate book, exact version pin, and date-basis are all part of policy identity.
-- This allows identical date ranges for the same customer when they are scoped
-- to different departments, subsidiaries, locations, classes, or projects.
alter table item_rate_book_assignments add column if not exists department_id uuid;
alter table item_rate_book_assignments add column if not exists subsidiary_id uuid;
alter table item_rate_book_assignments add column if not exists location_id uuid;
alter table item_rate_book_assignments add column if not exists class_id uuid;

alter table item_rate_book_assignments drop constraint if exists item_rate_assignment_one_scope;
alter table item_rate_book_assignments drop constraint if exists item_rate_assignment_one_primary_scope;
alter table item_rate_book_assignments
  add constraint item_rate_assignment_one_primary_scope
  check (not (customer_id is not null and project_id is not null));

create index if not exists item_rate_assignments_dimensions
  on item_rate_book_assignments (org_id, subsidiary_id, department_id, location_id, class_id);

-- Named, guarded FKs for the new scope columns (idempotent: added here because
-- this migration introduces the columns and already-provisioned DBs skip a
-- changed referential-integrity.sql).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'item_rate_assignments_department_fk') then
    alter table item_rate_book_assignments add constraint item_rate_assignments_department_fk foreign key (department_id) references departments(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'item_rate_assignments_subsidiary_fk') then
    alter table item_rate_book_assignments add constraint item_rate_assignments_subsidiary_fk foreign key (subsidiary_id) references subsidiaries(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'item_rate_assignments_location_fk') then
    alter table item_rate_book_assignments add constraint item_rate_assignments_location_fk foreign key (location_id) references locations(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'item_rate_assignments_class_fk') then
    alter table item_rate_book_assignments add constraint item_rate_assignments_class_fk foreign key (class_id) references classes(id);
  end if;
end $$;

create or replace function item_rate_book_assignments_no_overlap_guard() returns trigger
language plpgsql as $$
begin
  if not new.is_active then return new; end if;
  if exists (
    select 1
      from item_rate_book_assignments a
     where a.id <> new.id
       and a.org_id = new.org_id
       and a.is_active
       and a.customer_id is not distinct from new.customer_id
       and a.project_id is not distinct from new.project_id
       and a.department_id is not distinct from new.department_id
       and a.subsidiary_id is not distinct from new.subsidiary_id
       and a.location_id is not distinct from new.location_id
       and a.class_id is not distinct from new.class_id
       and a.rate_book_id = new.rate_book_id
       and a.rate_version_id is not distinct from new.rate_version_id
       and a.date_basis = new.date_basis
       and effective_date_ranges_overlap(coalesce(a.effective_from, '-infinity'::date), a.effective_to, coalesce(new.effective_from, '-infinity'::date), new.effective_to)
  ) then
    raise exception 'rate-book assignments overlap for the same assignment scope' using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists item_rate_book_assignments_no_overlap on item_rate_book_assignments;
create trigger item_rate_book_assignments_no_overlap
  before insert or update of org_id, rate_book_id, rate_version_id, customer_id, project_id, department_id, subsidiary_id, location_id, class_id, effective_from, effective_to, date_basis, is_active
  on item_rate_book_assignments
  for each row execute function item_rate_book_assignments_no_overlap_guard();

-- ---------------------------------------------------------------------------
-- Revenue recognition fair-value prices / SSP: one active price per item and
-- currency at any date. The recognition engine resolves SSP by (item, currency,
-- date) and picks a single row (revenue-recognition.ts), so item and currency
-- are the only lookup dimensions; low/high are attributes OF the chosen row, not
-- separate policies, and must not create overlapping candidates. effective_from
-- is nullable and means "open start" (matches the engine's `effective_from is
-- null or effective_from <= date` predicate), so it is normalized, never rejected.
-- ---------------------------------------------------------------------------
create or replace function fair_value_prices_no_overlap_guard() returns trigger
language plpgsql as $$
begin
  if not new.is_active then return new; end if;
  if exists (
    select 1
      from fair_value_prices f
     where f.id <> new.id
       and f.org_id = new.org_id
       and f.is_active
       and f.item_id = new.item_id
       and f.currency = new.currency
       and effective_date_ranges_overlap(coalesce(f.effective_from, '-infinity'::date), f.effective_to, coalesce(new.effective_from, '-infinity'::date), new.effective_to)
  ) then
    raise exception 'active fair-value prices overlap for the same item and currency' using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists fair_value_prices_no_overlap on fair_value_prices;
create trigger fair_value_prices_no_overlap
  before insert or update of org_id, item_id, currency, effective_from, effective_to, is_active
  on fair_value_prices
  for each row execute function fair_value_prices_no_overlap_guard();

-- Ownership interests: keep the ORIGINAL subsidiary-scoped overlap rule. A
-- subsidiary must consolidate exactly one way in any period — consolidation.ts
-- loops over every active interest whose window covers the period and posts
-- equity/NCI per row, so two overlapping active interests for one subsidiary
-- would double-post. method/acquisition are NOT lookup distinctions here; the
-- guard is restated unchanged only because this migration must be idempotent
-- alongside 0054 (function replace is a no-op when already correct).
create or replace function ownership_interest_guard() returns trigger language plpgsql as $$
declare actual_parent uuid; bad_account boolean;
begin
  select parent_id into actual_parent from subsidiaries where id=new.subsidiary_id and org_id=new.org_id and is_active and not is_elimination;
  if actual_parent is distinct from new.parent_subsidiary_id or not exists (select 1 from subsidiaries where id=new.parent_subsidiary_id and org_id=new.org_id and is_active and not is_elimination) then raise exception 'ownership interest must follow the active tenant consolidation hierarchy'; end if;
  if exists (
    select 1 from subsidiary_ownership_interests x
     where x.org_id = new.org_id
       and x.id <> new.id
       and x.is_active and new.is_active
       and x.subsidiary_id = new.subsidiary_id
       and effective_date_ranges_overlap(x.effective_from, x.effective_to, new.effective_from, new.effective_to)
  ) then raise exception 'ownership effective dates overlap for the subsidiary'; end if;
  select exists (select 1 from unnest(array_remove(array[new.investment_account_id,new.equity_income_account_id,new.distribution_account_id,new.distribution_income_account_id,new.nci_equity_account_id,new.nci_income_account_id,new.goodwill_account_id,new.fair_value_adjustment_account_id],null)) wanted(id) where not exists (select 1 from accounts a where a.id=wanted.id and a.org_id=new.org_id and a.is_active and not a.is_summary)) into bad_account;
  if bad_account then raise exception 'ownership accounts must be active postable accounts in the tenant'; end if;
  if new.method='full' and new.ownership_percent<100 and (new.nci_equity_account_id is null or new.nci_income_account_id is null) then raise exception 'full consolidation below 100 percent requires NCI equity and income accounts'; end if;
  if new.method='full' and (new.goodwill_account_id is null or new.fair_value_adjustment_account_id is null) then raise exception 'full consolidation requires goodwill and fair-value adjustment accounts'; end if;
  if new.distribution_account_id is not null and new.distribution_income_account_id is null then raise exception 'distribution income account is required when a distribution account is configured'; end if;
  if tg_op='UPDATE' and exists(select 1 from ownership_consolidation_entries where interest_id=old.id) and row(new.org_id,new.parent_subsidiary_id,new.subsidiary_id,new.effective_from,new.effective_to,new.ownership_percent,new.method,new.acquisition_date,new.acquisition_cost,new.fair_value_net_assets,new.acquisition_rate,new.nci_measurement,new.nci_fair_value,new.investment_account_id,new.equity_income_account_id,new.distribution_account_id,new.distribution_income_account_id,new.nci_equity_account_id,new.nci_income_account_id,new.goodwill_account_id,new.fair_value_adjustment_account_id,new.is_active) is distinct from row(old.org_id,old.parent_subsidiary_id,old.subsidiary_id,old.effective_from,old.effective_to,old.ownership_percent,old.method,old.acquisition_date,old.acquisition_cost,old.fair_value_net_assets,old.acquisition_rate,old.nci_measurement,old.nci_fair_value,old.investment_account_id,old.equity_income_account_id,old.distribution_account_id,old.distribution_income_account_id,old.nci_equity_account_id,old.nci_income_account_id,old.goodwill_account_id,old.fair_value_adjustment_account_id,old.is_active) then raise exception 'used ownership policy is immutable; close it and create a new effective-dated policy'; end if;
  return new;
end $$;

-- Referential-integrity / RLS scripts grant this role earlier; keep generated
-- migration self-contained for fresh DBs where the role already exists.
do $$ begin
  grant select on tax_rates, tax_registrations, labor_cost_rates, overhead_rates,
    item_rate_versions, item_rate_book_assignments, fair_value_prices,
    subsidiary_ownership_interests to openbooks_read;
exception when undefined_object then null;
end $$;
