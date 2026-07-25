-- Organization backups: a per-org scheduled-backup policy plus an auditable
-- ledger of backup runs. Backup payloads live in the app's S3 object storage
-- under backups/{org_id}/{run_id}.json.gz; these rows are the evidence —
-- who/what/when, byte size, sha256, and final disposition.
--
-- Rotation and manual deletion never hard-delete history: a purged run keeps
-- its row with purged_at + purge_reason so the retention trail is complete.

create table if not exists backup_policies (
  org_id uuid primary key,
  enabled boolean not null default false,
  frequency text not null default 'daily',
  hour_utc integer not null default 2,
  day_of_week integer not null default 1,
  day_of_month integer not null default 1,
  max_keep integer not null default 7,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  constraint backup_policies_frequency check (frequency in ('daily','weekly','monthly')),
  constraint backup_policies_hour check (hour_utc between 0 and 23),
  constraint backup_policies_day_of_week check (day_of_week between 0 and 6),
  -- 1–28 only: every month has these days, so the schedule never skips a month.
  constraint backup_policies_day_of_month check (day_of_month between 1 and 28),
  constraint backup_policies_max_keep check (max_keep between 1 and 100)
);
create index if not exists backup_policies_due on backup_policies(next_run_at) where enabled;

create table if not exists backup_runs (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  kind text not null,
  status text not null default 'queued',
  storage text not null default 's3',
  object_key text,
  file_name text,
  byte_size bigint,
  table_count integer,
  row_count bigint,
  sha256 text,
  error text,
  actor_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  purged_at timestamptz,
  purge_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint backup_runs_kind check (kind in ('manual','scheduled')),
  constraint backup_runs_status check (status in ('queued','running','completed','failed')),
  constraint backup_runs_purge_reason check (purge_reason in ('rotated','deleted')),
  constraint backup_runs_sha256 check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint backup_runs_nonnegative_size check (byte_size is null or byte_size >= 0),
  constraint backup_runs_nonnegative_counts check (
    (table_count is null or table_count >= 0) and (row_count is null or row_count >= 0))
);
create index if not exists backup_runs_org on backup_runs(org_id, created_at desc);
-- Rotation scan: live (completed, not yet purged) backups per org.
create index if not exists backup_runs_live on backup_runs(org_id, created_at desc)
  where status = 'completed' and purged_at is null;

alter table backup_policies
  add constraint backup_policies_org_fk foreign key (org_id) references orgs(id);
alter table backup_runs
  add constraint backup_runs_org_fk foreign key (org_id) references orgs(id),
  add constraint backup_runs_actor_fk foreign key (actor_id) references users(id) on delete set null;

alter table backup_policies enable row level security;
alter table backup_policies force row level security;
drop policy if exists org_isolation on backup_policies;
create policy org_isolation on backup_policies
  using (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true));

alter table backup_runs enable row level security;
alter table backup_runs force row level security;
drop policy if exists org_isolation on backup_runs;
create policy org_isolation on backup_runs
  using (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on' or org_id::text = current_setting('app.current_org', true));

grant select on backup_policies, backup_runs to openbooks_read;
