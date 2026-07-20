-- Tenant RLS hardening for tables added outside the baseline auto-policy pass.
-- Every org-owned table must have forced RLS, and org-less sensitive support
-- tables must derive visibility through their owning org-scoped parent.

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
  foreach t in array array[
    'charge_rate_components',
    'equipment_units',
    'item_rate_book_assignments',
    'item_rate_books',
    'item_rate_lines',
    'item_rate_profiles',
    'item_rate_versions',
    'project_types',
    'user_org_access'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', t, body, body);
  end loop;
end $$;

-- Remove the legacy CRM policies that keyed off openbooks.org_id. The standard
-- org_isolation policy remains on these tables and uses app.current_org.
do $$
declare
  r record;
begin
  for r in
    select c.relname as table_name, p.polname as policy_name
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and pg_get_expr(p.polqual, p.polrelid) like '%openbooks.org_id%'
  loop
    execute format('drop policy if exists %I on %I', r.policy_name, r.table_name);
  end loop;
end $$;

alter table orgs enable row level security;
alter table orgs force row level security;
drop policy if exists org_root_isolation on orgs;
create policy org_root_isolation on orgs
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or id::text = current_setting('app.current_org', true)
    or sandbox_of::text = current_setting('app.current_org', true)
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or id::text = current_setting('app.current_org', true)
    or sandbox_of::text = current_setting('app.current_org', true)
  );

alter table file_versions enable row level security;
alter table file_versions force row level security;
drop policy if exists file_versions_org_isolation on file_versions;
create policy file_versions_org_isolation on file_versions
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or exists (
      select 1 from files f
       where f.id = file_versions.file_id
         and f.org_id::text = current_setting('app.current_org', true)
    )
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or exists (
      select 1 from files f
       where f.id = file_versions.file_id
         and f.org_id::text = current_setting('app.current_org', true)
    )
  );

alter table file_blobs enable row level security;
alter table file_blobs force row level security;
drop policy if exists file_blobs_org_isolation on file_blobs;
create policy file_blobs_org_isolation on file_blobs
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or exists (
      select 1
        from file_versions fv
        join files f on f.id = fv.file_id
       where fv.id = file_blobs.version_id
         and f.org_id::text = current_setting('app.current_org', true)
    )
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or exists (
      select 1
        from file_versions fv
        join files f on f.id = fv.file_id
       where fv.id = file_blobs.version_id
         and f.org_id::text = current_setting('app.current_org', true)
    )
  );

alter table tax_group_members enable row level security;
alter table tax_group_members force row level security;
drop policy if exists tax_group_members_org_isolation on tax_group_members;
create policy tax_group_members_org_isolation on tax_group_members
  using (
    current_setting('app.bypass_rls', true) = 'on'
    or exists (
      select 1 from tax_groups tg
       where tg.id = tax_group_members.tax_group_id
         and tg.org_id::text = current_setting('app.current_org', true)
    )
  )
  with check (
    current_setting('app.bypass_rls', true) = 'on'
    or exists (
      select 1 from tax_groups tg
       where tg.id = tax_group_members.tax_group_id
         and tg.org_id::text = current_setting('app.current_org', true)
    )
  );

revoke select on _applied_migrations, file_blobs, file_versions, sftp_daemon, tax_group_members from openbooks_read;
