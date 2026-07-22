create table if not exists tax_jurisdictions (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  code text not null,
  name text not null,
  country text not null,
  region text,
  level text not null default 'country',
  tax_type text not null default 'other',
  parent_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint tax_jurisdictions_level check (level in ('country', 'state', 'county', 'city', 'special', 'federal')),
  constraint tax_jurisdictions_tax_type check (tax_type in ('vat', 'gst', 'hst', 'pst', 'qst', 'sales_use', 'consumption', 'other'))
);
create unique index if not exists tax_jurisdictions_org_code on tax_jurisdictions (org_id, code);
create index if not exists tax_jurisdictions_org_country on tax_jurisdictions (org_id, country);
create index if not exists tax_jurisdictions_parent on tax_jurisdictions (parent_id);

create table if not exists tax_registrations (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  jurisdiction_id uuid not null,
  registration_number text,
  filing_frequency text not null default 'quarterly',
  return_form_code text,
  effective_from date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint tax_registrations_frequency check (filing_frequency in ('monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual'))
);
create index if not exists tax_registrations_org on tax_registrations (org_id);
create index if not exists tax_registrations_jurisdiction on tax_registrations (jurisdiction_id);

alter table tax_codes add column if not exists jurisdiction_id uuid;
alter table tax_return_forms add column if not exists jurisdiction_id uuid;

grant select on tax_jurisdictions, tax_registrations to openbooks_read;

alter table tax_jurisdictions enable row level security;
alter table tax_jurisdictions force row level security;
drop policy if exists org_isolation on tax_jurisdictions;
create policy org_isolation on tax_jurisdictions
  using (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true));

alter table tax_registrations enable row level security;
alter table tax_registrations force row level security;
drop policy if exists org_isolation on tax_registrations;
create policy org_isolation on tax_registrations
  using (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true));
