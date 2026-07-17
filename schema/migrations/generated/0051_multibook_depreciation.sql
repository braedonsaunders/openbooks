-- Multi-book depreciation: accounting books post GL; alternate/reporting books
-- compute schedules without posting. Per-book, per-category method policy.
alter table accounting_books add column posts_gl boolean not null default true;

create table depreciation_book_policies (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  book_id uuid not null,
  category_id uuid not null,
  method text not null default 'straight_line',
  life_months integer,
  rate_percent numeric(19, 4),
  convention text not null default 'full_month',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint dep_book_policies_method_check check (method in ('straight_line','declining_balance','double_declining','units_of_production','manual')),
  constraint dep_book_policies_conv_check check (convention in ('full_month','mid_month','half_year'))
);
create unique index dep_book_policies_identity on depreciation_book_policies (org_id, book_id, category_id);
