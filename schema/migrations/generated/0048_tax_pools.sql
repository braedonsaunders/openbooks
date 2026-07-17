-- Jurisdiction-neutral tax depreciation pools (Canada CCA is one regime).
-- A pool depreciates a class of assets as one running balance on a tax book;
-- tax_pool_periods records the annual waterfall; tax_first_year_rules holds the
-- dated first-year config (half-year / AII), never hardcoded.

create table tax_depreciation_pools (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  book_id uuid not null,
  subsidiary_id uuid not null,
  regime text not null,
  class_code text not null,
  rate numeric(19, 10) not null,
  method text not null default 'declining',
  is_separate_class boolean not null default false,
  opening_balance numeric(19, 4) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint tax_pools_method_check check (method in ('declining', 'straight_line'))
);
create index tax_pools_org_book on tax_depreciation_pools (org_id, book_id);
create unique index tax_pools_identity
  on tax_depreciation_pools (org_id, book_id, subsidiary_id, regime, class_code, is_separate_class);

create table tax_pool_periods (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  pool_id uuid not null,
  tax_year integer not null,
  opening_balance numeric(19, 4) not null,
  additions numeric(19, 4) not null default 0,
  dispositions numeric(19, 4) not null default 0,
  net_additions numeric(19, 4) not null default 0,
  immediate_expense numeric(19, 4) not null default 0,
  base numeric(19, 4) not null default 0,
  allowance numeric(19, 4) not null default 0,
  closing_balance numeric(19, 4) not null default 0,
  recapture numeric(19, 4) not null default 0,
  terminal_loss numeric(19, 4) not null default 0,
  short_year_factor numeric(19, 10) not null default 1,
  enhanced_multiplier numeric(19, 10),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index tax_pool_periods_identity on tax_pool_periods (org_id, pool_id, tax_year);

create table tax_first_year_rules (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  regime text not null,
  class_code text,
  acquired_from date,
  acquired_to date,
  first_year_fraction numeric(19, 10) not null default 1,
  enhanced_multiplier numeric(19, 10),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index tax_first_year_rules_lookup on tax_first_year_rules (org_id, regime, class_code);
