-- Bank feed connections — one registry of how statements reach an account,
-- unifying manual / SFTP / Plaid / GoCardless / TrueLayer under Bank Feeds.

create table if not exists bank_feed_connections (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  name text not null,
  provider text not null,
  account_id uuid not null,
  status text not null default 'pending',
  credentials text,
  external_account_id text,
  sync_cadence text not null default 'daily',
  next_sync_at timestamptz,
  last_sync_at timestamptz,
  last_result jsonb,
  last_error text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint bank_feed_connections_provider check (provider in ('manual', 'sftp', 'plaid', 'gocardless', 'truelayer')),
  constraint bank_feed_connections_status check (status in ('pending', 'connected', 'error', 'disconnected')),
  constraint bank_feed_connections_cadence check (sync_cadence in ('manual', 'hourly', 'daily'))
);
create index if not exists bank_feed_connections_org on bank_feed_connections (org_id, is_active);
create index if not exists bank_feed_connections_due on bank_feed_connections (is_active, next_sync_at);

grant select on bank_feed_connections to openbooks_read;

do $$
declare
  body text := $pol$
    (
      current_setting('app.bypass_rls', true) = 'on'
      or org_id::text = current_setting('app.current_org', true)
    )
  $pol$;
begin
  execute 'alter table bank_feed_connections enable row level security';
  execute 'alter table bank_feed_connections force row level security';
  execute 'drop policy if exists org_isolation on bank_feed_connections';
  execute format('create policy org_isolation on bank_feed_connections using (%s) with check (%s)', body, body);
end $$;
