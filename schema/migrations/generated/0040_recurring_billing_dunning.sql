-- Recurring billing runner bookkeeping + the dunning (automated collections)
-- ladder. The recurring_schedules table already existed (baseline) but had no
-- runner; these columns let engine/src/recurring.ts record what it produced.

alter table recurring_schedules
  add column if not exists name text,
  add column if not exists run_count integer not null default 0,
  add column if not exists last_document_id uuid,
  add column if not exists last_error text;

create table if not exists dunning_policies (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  name text not null,
  applies_to_kind text not null default 'customer_invoice',
  grace_period_days integer not null default 0,
  min_balance numeric(19, 4) not null default 0,
  reply_to text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index if not exists dunning_policies_org_active
  on dunning_policies (org_id, is_active);

create table if not exists dunning_stages (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  policy_id uuid not null,
  sequence integer not null,
  name text not null,
  offset_days integer not null,
  subject_template text not null,
  body_template text not null,
  escalate boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create unique index if not exists dunning_stages_policy_seq
  on dunning_stages (policy_id, sequence);

create table if not exists dunning_log (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  document_id uuid not null,
  policy_id uuid not null,
  stage_id uuid not null,
  party_id uuid,
  to_email text,
  amount_due numeric(19, 4) not null default 0,
  currency_code text,
  channel text not null default 'email',
  status text not null default 'sent',
  detail text,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint dunning_log_status check (status in ('sent', 'failed', 'skipped'))
);
-- One row per (invoice, stage): this uniqueness is the idempotency guard that
-- stops a stage re-firing on the next scheduler tick.
create unique index if not exists dunning_log_document_stage
  on dunning_log (document_id, stage_id);
create index if not exists dunning_log_org_doc
  on dunning_log (org_id, document_id);

-- dunning_log is append-only evidence: allow insert, forbid update/delete via a
-- guard trigger consistent with the other evidence tables.
create or replace function dunning_log_guard() returns trigger as $$
begin
  if current_setting('app.bypass_rls', true) = 'on' then
    return coalesce(new, old);
  end if;
  raise exception 'dunning_log is append-only';
end;
$$ language plpgsql;
drop trigger if exists dunning_log_no_mutate on dunning_log;
create trigger dunning_log_no_mutate
  before update or delete on dunning_log
  for each row execute function dunning_log_guard();

grant select on dunning_policies, dunning_stages, dunning_log to openbooks_read;

-- Force tenant RLS on the three new tables (same policy body as every other
-- org-owned table).
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
  foreach t in array array['dunning_policies', 'dunning_stages', 'dunning_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', t, body, body);
  end loop;
end $$;
