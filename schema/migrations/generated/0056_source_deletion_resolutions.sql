create table if not exists source_deletion_resolutions (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null references orgs(id) on delete cascade,
  connection_id uuid not null references connections(id) on delete cascade,
  source_ref text not null,
  document_id uuid references documents(id) on delete set null,
  action text not null check (action in ('retain', 'void')),
  note text,
  resolved_at timestamptz not null default now(),
  resolved_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null,
  unique (connection_id, source_ref)
);

create index if not exists source_deletion_resolutions_org
  on source_deletion_resolutions (org_id, resolved_at);

alter table source_deletion_resolutions enable row level security;
alter table source_deletion_resolutions force row level security;
drop policy if exists org_isolation on source_deletion_resolutions;
create policy org_isolation on source_deletion_resolutions
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true)
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true)
  );

grant select on source_deletion_resolutions to openbooks_read;
