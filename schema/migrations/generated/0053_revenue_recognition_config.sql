-- Revenue recognition (ASC 606 / IFRS 15), NetSuite ARM-shaped and fully
-- org-configurable. Recognition rules carry method + date sources + offsets +
-- initial amount + accounts; fair-value prices drive relative-SSP allocation;
-- items gain rev-rec defaults. The revenue scaffolding tables (empty, unused)
-- are recreated in the richer shape — pre-launch, no legacy to preserve.

drop table if exists recognition_schedule_lines cascade;
drop table if exists recognition_schedules cascade;
drop table if exists performance_obligations cascade;
drop table if exists recognition_rules cascade;

create table recognition_rules (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  code text not null,
  name text not null,
  method text not null,
  is_forecast boolean not null default false,
  recognition_periods integer,
  start_date_source text not null default 'obligation',
  end_date_source text not null default 'term',
  period_offset integer not null default 0,
  start_offset_days integer not null default 0,
  initial_amount_percent numeric(19, 4) not null default '0',
  deferred_account_id uuid,
  recognized_account_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint recognition_rules_method_check check (method in
    ('point_in_time','straight_line_even','straight_line_prorate_first_last',
     'straight_line_daily','percent_complete','milestone','usage')),
  constraint recognition_rules_start_src_check check (start_date_source in
    ('obligation','document','fulfillment','event','contract')),
  constraint recognition_rules_end_src_check check (end_date_source in
    ('term','obligation','contract'))
);
create unique index recognition_rules_org_code on recognition_rules (org_id, code);

create table fair_value_prices (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  item_id uuid not null,
  currency text not null,
  unit_price numeric(19, 4) not null,
  low_value numeric(19, 4),
  high_value numeric(19, 4),
  effective_from date,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index fair_value_item on fair_value_prices (item_id, currency, effective_from);

create table performance_obligations (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  contract_id uuid not null,
  document_line_id uuid,
  item_id uuid,
  description text not null,
  recognition_rule_id uuid not null,
  booked_amount numeric(19, 4),
  standalone_selling_price numeric(19, 4),
  allocated_price numeric(19, 4) not null,
  percent_complete numeric(19, 4),
  recognition_starts_on date,
  recognition_ends_on date,
  deferred_account_id uuid,
  recognized_account_id uuid,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint obligations_status_check check (status in ('open','satisfied','cancelled'))
);
create index obligations_contract on performance_obligations (contract_id);
create index obligations_doc_line on performance_obligations (document_line_id);

create table recognition_schedules (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  obligation_id uuid not null,
  book_id uuid not null,
  status text not null default 'planned',
  total_amount numeric(19, 4) not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint rec_schedules_status_check check (status in ('planned','in_progress','complete'))
);
create unique index rec_schedules_obligation_book on recognition_schedules (obligation_id, book_id);

create table recognition_schedule_lines (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  schedule_id uuid not null,
  period_id uuid not null,
  sequence integer not null,
  planned_amount numeric(19, 4) not null,
  recognized_amount numeric(19, 4),
  journal_entry_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index rec_lines_schedule on recognition_schedule_lines (schedule_id);
create index rec_lines_period on recognition_schedule_lines (period_id);

-- revenue_contracts already exists (0000_init); add the currency column.
alter table revenue_contracts add column if not exists currency text;

-- Item-level revenue-recognition defaults.
alter table items add column if not exists recognition_rule_id uuid;
alter table items add column if not exists deferred_account_id uuid;
alter table items add column if not exists create_plans_on text not null default 'billing';
alter table items add column if not exists revenue_allocation text not null default 'normal';
alter table items add column if not exists standalone_selling_price numeric(19, 4);
alter table items add constraint items_create_plans_on_check
  check (create_plans_on in ('billing','fulfillment','arrangement'));
alter table items add constraint items_revenue_allocation_check
  check (revenue_allocation in ('normal','exclude','software'));
