-- User-authored depreciation methods (the formula builder). Formulas over the
-- depreciation variable set; categories/assets reference one by code.
create table depreciation_methods (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  code text not null,
  name text not null,
  formula text not null,
  end_of_life text not null default 'fully_depreciate',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint depreciation_methods_eol_check check (end_of_life in ('fully_depreciate','retain_balance'))
);
create unique index depreciation_methods_org_code on depreciation_methods (org_id, code);
