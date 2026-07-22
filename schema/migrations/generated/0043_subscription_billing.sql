-- Subscription billing — plans + subscriptions that auto-generate recurring
-- customer invoices (SaaS/retainer style). Gated by the subscriptionBilling
-- feature.

create table if not exists subscription_plans (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  name text not null,
  description text,
  amount numeric(19, 4) not null default 0,
  currency_code text,
  interval text not null default 'monthly',
  interval_count integer not null default 1,
  income_account_id uuid,
  item_id uuid,
  tax_code_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint subscription_plans_interval check (interval in ('weekly', 'monthly', 'quarterly', 'annually'))
);
create index if not exists subscription_plans_org on subscription_plans (org_id, is_active);

create table if not exists subscriptions (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  customer_id uuid not null,
  plan_id uuid not null,
  quantity numeric(19, 4) not null default 1,
  price_override numeric(19, 4),
  status text not null default 'active',
  start_on date not null,
  next_bill_on date not null,
  canceled_on date,
  auto_post boolean not null default false,
  last_invoice_id uuid,
  last_billed_at timestamptz,
  run_count integer not null default 0,
  last_error text,
  memo text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint subscriptions_status check (status in ('active', 'paused', 'canceled'))
);
create index if not exists subscriptions_org_status on subscriptions (org_id, status);
create index if not exists subscriptions_due on subscriptions (status, next_bill_on);

grant select on subscription_plans, subscriptions to openbooks_read;

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
  foreach t in array array['subscription_plans', 'subscriptions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', t, body, body);
  end loop;
end $$;
