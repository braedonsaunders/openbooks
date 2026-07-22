-- Durable scheduled-report occurrences, immutable rendered artifacts, and a
-- per-recipient delivery outbox. The database commit is the source of truth;
-- Redis is only a dispatcher and can be rebuilt after an outage.

alter table report_runs
  add column if not exists scheduled_for timestamptz,
  add column if not exists recipient_emails jsonb not null default '[]'::jsonb,
  add column if not exists filters jsonb,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists dispatch_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists locked_at timestamptz;

alter table report_runs drop constraint if exists report_runs_nonnegative_delivery_counts;
alter table report_runs add constraint report_runs_nonnegative_delivery_counts
  check (attempt_count >= 0 and dispatch_count >= 0);

create unique index if not exists report_runs_schedule_occurrence
  on report_runs(schedule_id, scheduled_for)
  where schedule_id is not null and scheduled_for is not null;

create table if not exists report_run_artifacts (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  run_id uuid not null,
  filename text not null,
  content_type text not null,
  size_bytes integer not null,
  content_hash text not null,
  bytes bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint report_run_artifacts_positive_size check (size_bytes > 0),
  constraint report_run_artifacts_sha256 check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint report_run_artifacts_pdf check (content_type = 'application/pdf')
);
create unique index if not exists report_run_artifacts_run on report_run_artifacts(run_id);
create index if not exists report_run_artifacts_org on report_run_artifacts(org_id, created_at);

create table if not exists report_delivery_outbox (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  run_id uuid not null,
  recipient text not null,
  status text not null default 'pending',
  dispatch_count integer not null default 0,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  queue_job_id text,
  email_log_id uuid,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint report_delivery_outbox_status check (status in ('pending','enqueued','sending','sent','failed','suppressed')),
  constraint report_delivery_outbox_nonnegative_counts check (dispatch_count >= 0 and attempt_count >= 0),
  constraint report_delivery_outbox_recipient check (length(btrim(recipient)) > 3)
);
create unique index if not exists report_delivery_outbox_run_recipient on report_delivery_outbox(run_id, recipient);
create index if not exists report_delivery_outbox_due on report_delivery_outbox(status, next_attempt_at);
create index if not exists report_delivery_outbox_org on report_delivery_outbox(org_id, created_at);

alter table report_run_artifacts
  add constraint report_run_artifacts_org_fk foreign key (org_id) references orgs(id),
  add constraint report_run_artifacts_run_fk foreign key (run_id) references report_runs(id) on delete cascade;
alter table report_delivery_outbox
  add constraint report_delivery_outbox_org_fk foreign key (org_id) references orgs(id),
  add constraint report_delivery_outbox_run_fk foreign key (run_id) references report_runs(id) on delete cascade,
  add constraint report_delivery_outbox_email_log_fk foreign key (email_log_id) references email_log(id) on delete set null;

alter table report_run_artifacts enable row level security;
alter table report_run_artifacts force row level security;
drop policy if exists org_isolation on report_run_artifacts;
create policy org_isolation on report_run_artifacts
  using (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true));

alter table report_delivery_outbox enable row level security;
alter table report_delivery_outbox force row level security;
drop policy if exists org_isolation on report_delivery_outbox;
create policy org_isolation on report_delivery_outbox
  using (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true));

grant select on report_run_artifacts, report_delivery_outbox to openbooks_read;
