-- Stateful authentication hardening. Additive and forward-only so existing
-- alpha.3 installations do not need the immutable 0001 baseline rewritten.

create table public.auth_sessions (
  id uuid default public.uuid_generate_v7() primary key,
  user_id uuid not null references public.users(id) on delete cascade deferrable initially immediate,
  token_hash text not null,
  auth_method text not null check (auth_method in ('password', 'oidc')),
  network_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revocation_reason text,
  check (revoked_at is not null or revocation_reason is null)
);
create unique index auth_sessions_token_hash on public.auth_sessions(token_hash);
create index auth_sessions_user_active on public.auth_sessions(user_id, revoked_at, expires_at);
create index auth_sessions_expiry on public.auth_sessions(expires_at);

create table public.auth_login_state (
  email_hash text primary key,
  user_id uuid references public.users(id) on delete cascade deferrable initially immediate,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_failed_at timestamptz,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
create index auth_login_state_user on public.auth_login_state(user_id);
create index auth_login_state_locked on public.auth_login_state(locked_until);
create index auth_login_state_updated on public.auth_login_state(updated_at);

create table public.auth_login_events (
  id uuid default public.uuid_generate_v7() primary key,
  user_id uuid references public.users(id) on delete set null deferrable initially immediate,
  email_hash text not null,
  network_hash text,
  user_agent_hash text,
  outcome text not null check (outcome in (
    'success', 'failure', 'locked', 'rate_limited', 'mfa_required',
    'mfa_failure', 'oidc_failure'
  )),
  auth_method text not null check (auth_method in ('password', 'oidc')),
  occurred_at timestamptz not null default now()
);
create index auth_login_events_email_time on public.auth_login_events(email_hash, occurred_at);
create index auth_login_events_network_time on public.auth_login_events(network_hash, occurred_at);
create index auth_login_events_user_time on public.auth_login_events(user_id, occurred_at);
create index auth_login_events_retention on public.auth_login_events(occurred_at);
create index auth_login_events_email_failure_time
  on public.auth_login_events(email_hash, occurred_at)
  where outcome in ('failure', 'mfa_failure');
create index auth_login_events_network_failure_time
  on public.auth_login_events(network_hash, occurred_at)
  where outcome in ('failure', 'mfa_failure');
create index auth_login_events_user_failure_time
  on public.auth_login_events(user_id, occurred_at)
  where outcome in ('failure', 'mfa_failure');

create table public.auth_mfa_factors (
  id uuid default public.uuid_generate_v7() primary key,
  user_id uuid not null references public.users(id) on delete cascade deferrable initially immediate,
  secret_encrypted text not null,
  recovery_code_hashes jsonb not null default '[]'::jsonb,
  enabled_at timestamptz,
  last_used_step integer,
  setup_session_id uuid references public.auth_sessions(id) on delete cascade deferrable initially immediate,
  setup_expires_at timestamptz,
  setup_attempt_count integer not null default 0 check (setup_attempt_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(recovery_code_hashes) = 'array'),
  check (
    (enabled_at is null and setup_session_id is not null and setup_expires_at is not null)
    or
    (enabled_at is not null and setup_session_id is null and setup_expires_at is null and setup_attempt_count = 0)
  )
);
create unique index auth_mfa_factors_user on public.auth_mfa_factors(user_id);
create index auth_mfa_factors_setup_expiry on public.auth_mfa_factors(setup_expires_at);

create table public.auth_rate_limit_buckets (
  bucket_key text primary key,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now()
);
create index auth_rate_limit_buckets_updated on public.auth_rate_limit_buckets(updated_at);

create table public.auth_login_challenges (
  id uuid default public.uuid_generate_v7() primary key,
  user_id uuid not null references public.users(id) on delete cascade deferrable initially immediate,
  email_hash text not null,
  auth_method text not null check (auth_method in ('password', 'oidc')),
  network_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);
create index auth_login_challenges_user on public.auth_login_challenges(user_id, expires_at);
create index auth_login_challenges_expiry on public.auth_login_challenges(expires_at);

create table public.auth_oidc_identities (
  id uuid default public.uuid_generate_v7() primary key,
  issuer text not null,
  subject text not null,
  user_id uuid not null references public.users(id) on delete cascade deferrable initially immediate,
  email_at_link text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index auth_oidc_identities_subject on public.auth_oidc_identities(issuer, subject);
create unique index auth_oidc_identities_user_issuer on public.auth_oidc_identities(user_id, issuer);
create index auth_oidc_identities_user on public.auth_oidc_identities(user_id);

-- Password login and first-use OIDC linking resolve an active production user
-- by a global, case-folded email. Bound that lookup before the org join.
create index users_login_email_ci on public.users(lower(email)) where is_active;

-- Authentication is pre-tenant. These tables intentionally have no org_id and
-- therefore receive no tenant RLS policy; application access remains limited to
-- the server runtime database role configured by scripts/bootstrap.ts.
