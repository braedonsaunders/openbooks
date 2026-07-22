alter table item_rate_book_assignments
  add column if not exists date_basis text not null default 'usage_date',
  add column if not exists rate_version_id uuid;
alter table item_rate_book_assignments
  drop constraint if exists item_rate_book_assignments_date_basis,
  add constraint item_rate_book_assignments_date_basis check (date_basis in ('usage_date', 'project_start'));

alter table time_entries
  add column if not exists bill_rate_source_rate numeric(19,4),
  add column if not exists bill_rate_source_currency text,
  add column if not exists bill_rate_fx_rate numeric(19,10),
  add column if not exists bill_rate_currency text,
  add column if not exists bill_rate_book_id uuid,
  add column if not exists bill_rate_version_id uuid,
  add column if not exists bill_rate_line_id uuid;

create table if not exists labor_rate_version_policies (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  version_id uuid not null,
  derivation_policy text not null default 'explicit',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint labor_rate_version_policies_derivation check (derivation_policy in ('explicit', 'time_type_multipliers'))
);
create unique index if not exists labor_rate_version_policies_version on labor_rate_version_policies (version_id);

create table if not exists labor_rate_version_scopes (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  version_id uuid not null,
  scope_type text not null,
  scope_value_id uuid,
  scope_value_text text,
  include_children boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint labor_rate_version_scopes_type check (scope_type in ('department', 'subsidiary', 'location', 'class', 'trade', 'job_title', 'other')),
  constraint labor_rate_version_scopes_one_value check (num_nonnulls(scope_value_id, scope_value_text) = 1)
);
create index if not exists labor_rate_version_scopes_version on labor_rate_version_scopes (version_id);

create table if not exists labor_rate_adjustments (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  version_id uuid not null,
  item_id uuid,
  code text not null,
  name text not null,
  category text not null,
  calculation text not null,
  value numeric(19, 10),
  unit text,
  presentation text not null default 'included',
  threshold numeric(19, 4),
  threshold_unit text,
  reference_text text,
  applies_regular boolean not null default true,
  applies_overtime boolean not null default true,
  applies_double_time boolean not null default true,
  applies_shift boolean not null default true,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint labor_rate_adjustments_category check (category in ('markup', 'travel', 'allowance', 'minimum', 'surcharge', 'other')),
  constraint labor_rate_adjustments_calculation check (calculation in ('percent', 'fixed', 'per_hour', 'per_day', 'distance', 'time', 'text')),
  constraint labor_rate_adjustments_presentation check (presentation in ('included', 'separate', 'informational')),
  constraint labor_rate_adjustments_nonnegative_value check (value is null or value >= 0),
  constraint labor_rate_adjustments_nonnegative_threshold check (threshold is null or threshold >= 0)
);
create unique index if not exists labor_rate_adjustments_version_item_code on labor_rate_adjustments (version_id, item_id, code) nulls not distinct;
create index if not exists labor_rate_adjustments_version on labor_rate_adjustments (version_id, item_id, sort_order);

create table if not exists labor_rate_terms (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  version_id uuid not null,
  code text not null,
  label text not null,
  content text not null,
  placement text not null default 'conditions',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint labor_rate_terms_placement check (placement in ('header', 'conditions', 'footer'))
);
create unique index if not exists labor_rate_terms_version_code on labor_rate_terms (version_id, code);
create index if not exists labor_rate_terms_version on labor_rate_terms (version_id, sort_order);

grant select on labor_rate_version_policies, labor_rate_version_scopes, labor_rate_adjustments, labor_rate_terms to openbooks_read;
