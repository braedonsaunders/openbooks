-- OpenBooks environments (sandboxes) — engine primitives + row-level security.
-- Applied after the canonical baseline and rerun only when its digest or the
-- live tenant-isolation catalog changes.

-- ---------------------------------------------------------------------------
-- ob_rebase(old, seed): the deterministic UUID-rebase function that powers the
-- clone engine. Every PK and FK in a sandbox is old_id rebased through the same
-- seed, so the copied graph stays internally consistent with no mapping table.
-- md5-based → zero extension dependency; the (seed, old) input guarantees
-- determinism and negligible collision probability across environments.
-- ---------------------------------------------------------------------------
create or replace function ob_rebase(old uuid, seed uuid) returns uuid
  language sql immutable parallel safe as $$
    select md5(seed::text || ':' || old::text)::uuid
$$;

-- ---------------------------------------------------------------------------
-- Make every foreign key DEFERRABLE INITIALLY IMMEDIATE. Normal app writes are
-- unaffected (still checked immediately), but the clone engine can `set
-- constraints all deferred` so it copies tables in any order — essential
-- because the schema has reference cycles (e.g. documents.posted_entry_id ↔
-- journal_entries.source_document_id) that no insert ordering can satisfy. The
-- deterministic rebase guarantees referential integrity at commit.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select conrelid::regclass::text as tbl, conname
      from pg_constraint
     where contype = 'f'
       and connamespace = 'public'::regnamespace
       and not condeferrable
  loop
    execute format('alter table %s alter constraint %I deferrable initially immediate', r.tbl, r.conname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Authenticated connector historical replay.
--
-- A controller-authorized connector mirror may discover that an upstream
-- transaction changed after OpenBooks closed the same historical period. The
-- correction remains append-only (original -> reversal -> replacement) and
-- does not reopen or mutate the lock. A transaction-local replay token is
-- accepted only when it resolves to an active sync run, its owning connection
-- and organization, and the connection's attributable automatic policy.
-- ---------------------------------------------------------------------------
create or replace function connector_historical_replay_authorized(
  p_org uuid
) returns boolean
  language sql
  stable
  set search_path = public, pg_catalog
as $$
  select
    coalesce(current_setting('openbooks.connector_replay', true), 'off') = 'on'
    and nullif(current_setting('openbooks.connector_replay_request', true), '') is not null
    and nullif(current_setting('openbooks.connector_replay_actor', true), '') is not null
    and current_setting('app.current_org', true) = p_org::text
    and exists (
      select 1
        from sync_runs run
        join connections connection
          on connection.id = run.connection_id
         and connection.org_id = run.org_id
        join users controller
          on controller.id = connection.posted_change_authorized_by
         and controller.org_id = connection.org_id
         and controller.is_active
       where run.id::text = current_setting('openbooks.connector_replay_request', true)
         and run.org_id = p_org
         and run.status = 'running'
         and run.kind in ('incremental', 'full_migration')
         and run.source = connection.source
         and connection.status not in ('paused', 'unconfigured')
         and connection.posted_change_policy = 'append_only_automatic'
         and connection.posted_change_authorized_at is not null
         and run.started_at >= connection.posted_change_authorized_at
         and connection.posted_change_authorized_by::text =
               current_setting('openbooks.connector_replay_actor', true)
    )
$$;

comment on function connector_historical_replay_authorized(uuid) is
  'Fail-closed proof for controller-authorized append-only connector replay into a preserved closed period.';

create or replace function period_module_blocks_write(
  p_org uuid,
  p_period uuid,
  p_book uuid,
  p_subsidiary uuid,
  p_module text,
  p_allow_imported boolean
) returns boolean
  language sql
  stable
  set search_path = public, pg_catalog
as $$
  select case
    when p_allow_imported
      and connector_historical_replay_authorized(p_org)
      then false
    else coalesce(
      (select case
         when p_allow_imported and reason = 'close.importedPeriodLockReason' then false
         when state = 'closed' then true
         when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
         else false
       end
         from period_locks
        where org_id = p_org and period_id = p_period and book_id = p_book
          and subsidiary_id = p_subsidiary and module = p_module),
      (select case
         when p_allow_imported and reason = 'close.importedPeriodLockReason' then false
         when state = 'closed' then true
         when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
         else false
       end
         from period_locks
        where org_id = p_org and period_id = p_period and book_id = p_book
          and subsidiary_id is null and module = p_module),
      false
    )
  end
$$;

comment on function period_module_blocks_write(
  uuid, uuid, uuid, uuid, text, boolean
) is
  'Blocks closed-period writes except source-owned imported locks or a database-authenticated connector replay; never changes the lock itself.';

-- ---------------------------------------------------------------------------
-- Row-level security. Tenant isolation is enforced at the database, keyed on two
-- GUCs the connection layer sets from AsyncLocalStorage (see engine/src/db.ts):
--   app.current_org  — the tenant a request is scoped to
--   app.bypass_rls   — 'on' for trusted org-spanning code (clone engine, seeds)
--
-- DENY BY DEFAULT: with neither GUC set, business tables return zero rows. Every
-- authenticated web request sets app.current_org (currentUser → setRequestOrg),
-- so it sees only its own tenant; trusted server code runs with bypass on. A
-- missing scope fails closed (no rows), never open (cross-tenant leak).
--
-- The policy is created for every BASE TABLE carrying an `org_id` column, so it
-- auto-covers tables added later — re-run this file after adding tables.
-- `sandboxes` is excluded (its org_id is the SANDBOX org; it's managed from the
-- production context) and gets a bespoke policy keyed on production_org_id.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  relation_oid oid;
  rls_enabled boolean;
  rls_forced boolean;
  policy_version text;
  body text := $pol$
    (
      current_setting('app.bypass_rls', true) = 'on'
      or org_id::text = current_setting('app.current_org', true)
    )
  $pol$;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_name = c.table_name and tb.table_schema = c.table_schema
     where c.table_schema = 'public'
       and c.column_name = 'org_id'
       and tb.table_type = 'BASE TABLE'
       -- Excluded: managed cross-tenant tables keyed on something other than the
       -- current org (sandboxes → production_org_id; user_org_access is the
       -- identity/access table, queried during the pre-context auth bootstrap).
       and c.table_name not in ('sandboxes', 'user_org_access')
  loop
    select c.oid, c.relrowsecurity, c.relforcerowsecurity
      into relation_oid, rls_enabled, rls_forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t;
    if not rls_enabled then
      execute format('alter table %I enable row level security', t);
    end if;
    if not rls_forced then
      execute format('alter table %I force row level security', t);
    end if;
    select obj_description(p.oid, 'pg_policy')
      into policy_version
      from pg_policy p
     where p.polrelid = relation_oid and p.polname = 'org_isolation';
    if policy_version is distinct from 'openbooks:org_isolation:v1' then
      execute format('drop policy if exists org_isolation on %I', t);
      execute format(
        'create policy org_isolation on %I using (%s) with check (%s)',
        t, body, body);
      execute format(
        'comment on policy org_isolation on %I is %L',
        t, 'openbooks:org_isolation:v1');
    end if;
  end loop;
end $$;

-- sandboxes: visible from either the production org that owns them or the
-- sandbox org itself (trusted bypass sees all).
do $$
declare
  policy_version text;
  rls_enabled boolean;
  rls_forced boolean;
begin
  select relrowsecurity, relforcerowsecurity
    into rls_enabled, rls_forced
    from pg_class
   where oid = 'public.sandboxes'::regclass;
  if not rls_enabled then
    alter table sandboxes enable row level security;
  end if;
  if not rls_forced then
    alter table sandboxes force row level security;
  end if;
  select obj_description(p.oid, 'pg_policy')
    into policy_version
    from pg_policy p
   where p.polrelid = 'public.sandboxes'::regclass
     and p.polname = 'sandbox_isolation';
  if policy_version is distinct from 'openbooks:sandbox_isolation:v1' then
    drop policy if exists sandbox_isolation on sandboxes;
    create policy sandbox_isolation on sandboxes
      using (
        current_setting('app.bypass_rls', true) = 'on'
        or org_id::text = current_setting('app.current_org', true)
        or production_org_id::text = current_setting('app.current_org', true)
      )
      with check (
        current_setting('app.bypass_rls', true) = 'on'
        or production_org_id::text = current_setting('app.current_org', true)
      );
    comment on policy sandbox_isolation on sandboxes
      is 'openbooks:sandbox_isolation:v1';
  end if;
end $$;
