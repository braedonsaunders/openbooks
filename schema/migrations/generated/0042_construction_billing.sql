-- Construction progress billing — AIA G702/G703: schedule of values, change
-- orders, applications for payment, with retainage withheld into a Retainage
-- Receivable subledger by the standard customer_invoice kernel rule.

create table if not exists sov_lines (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  project_id uuid not null,
  item_no text,
  description text not null,
  scheduled_value numeric(19, 4) not null default 0,
  retainage_percent numeric(19, 4),
  income_account_id uuid,
  sort_order integer not null default 0,
  change_order_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index if not exists sov_lines_project on sov_lines (org_id, project_id, sort_order);

create table if not exists change_orders (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  project_id uuid not null,
  number text not null,
  description text,
  status text not null default 'draft',
  amount numeric(19, 4) not null default 0,
  approved_on date,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint change_orders_status check (status in ('draft', 'approved', 'void'))
);
create unique index if not exists change_orders_project_number on change_orders (org_id, project_id, number);
create index if not exists change_orders_project on change_orders (org_id, project_id);

create table if not exists pay_applications (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  project_id uuid not null,
  application_number integer not null,
  period_end date not null,
  kind text not null default 'progress',
  status text not null default 'draft',
  retainage_percent numeric(19, 4) not null default 10,
  invoice_document_id uuid,
  memo text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint pay_applications_kind check (kind in ('progress', 'retainage_release')),
  constraint pay_applications_status check (status in ('draft', 'submitted', 'approved', 'posted', 'void'))
);
create unique index if not exists pay_applications_project_number on pay_applications (org_id, project_id, application_number);
create index if not exists pay_applications_project on pay_applications (org_id, project_id, status);

create table if not exists pay_application_lines (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  pay_application_id uuid not null,
  sov_line_id uuid not null,
  previous_completed numeric(19, 4) not null default 0,
  this_period_completed numeric(19, 4) not null default 0,
  materials_stored numeric(19, 4) not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index if not exists pay_application_lines_app_sov on pay_application_lines (pay_application_id, sov_line_id);
create index if not exists pay_application_lines_app on pay_application_lines (org_id, pay_application_id);

grant select on sov_lines, change_orders, pay_applications, pay_application_lines to openbooks_read;

do $$
declare
  t text;
  body text := $pol$
    (
      current_setting('app.bypass_rls', true) = 'on'
      or org_id::text = current_setting('app.current_org', true)
    )
  $pol$;
begin
  foreach t in array array['sov_lines', 'change_orders', 'pay_applications', 'pay_application_lines']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', t, body, body);
  end loop;
end $$;
