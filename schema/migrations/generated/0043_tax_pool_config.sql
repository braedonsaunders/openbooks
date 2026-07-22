create table if not exists tax_regimes (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  code text not null,
  name text not null,
  class_attribute text not null default 'tax_pool_class',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index if not exists tax_regimes_org_code on tax_regimes (org_id, code);

create table if not exists tax_pool_classes (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  regime text not null,
  class_code text not null,
  name text not null,
  rate numeric(19, 10) not null,
  method text not null default 'declining',
  first_year_fraction numeric(19, 10) not null default 1,
  allow_recapture boolean not null default true,
  allow_terminal_loss boolean not null default true,
  cost_cap numeric(19, 4),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint tax_pool_classes_method check (method in ('declining', 'straight_line'))
);
create unique index if not exists tax_pool_classes_identity on tax_pool_classes (org_id, regime, class_code);

grant select on tax_regimes, tax_pool_classes to openbooks_read;

alter table tax_regimes enable row level security;
alter table tax_regimes force row level security;
drop policy if exists org_isolation on tax_regimes;
create policy org_isolation on tax_regimes
  using (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true));

alter table tax_pool_classes enable row level security;
alter table tax_pool_classes force row level security;
drop policy if exists org_isolation on tax_pool_classes;
create policy org_isolation on tax_pool_classes
  using (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true));
