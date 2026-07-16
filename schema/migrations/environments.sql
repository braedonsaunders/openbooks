-- openbooks environments (sandboxes) — engine primitives + row-level security.
-- Applied after the generated DDL and referential-integrity.sql, alongside
-- kernel-constraints.sql.

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
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I using (%s) with check (%s)',
      t, body, body);
  end loop;
end $$;

-- sandboxes: visible from either the production org that owns them or the
-- sandbox org itself (trusted bypass sees all).
alter table sandboxes enable row level security;
alter table sandboxes force row level security;
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
