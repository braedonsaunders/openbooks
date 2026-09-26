/** Database roles, RLS, and test ownership. Split from scripts/bootstrap.ts (pure moves only). */
import { migrationsDir, quoted, sha256 } from "../bootstrap-paths"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { revokeRuntimeFunctionExecute } from "../bootstrap-function-denials.ts"
import { sql } from "drizzle-orm"
import pg from "pg"
import { constrainedSchemaOwnerRefusal, verifyReadRoleAssumption, type RuntimeDatabaseConfig } from "../bootstrap-roles.ts"
import { db, env, pool } from "../../engine/src/platform/db.ts"
import { connectMigrationClient, describeBootstrapMigrationFailure, releaseMigrationClient } from "../bootstrap-migration-client.ts"


export async function assertConstrainedSchemaOwnerMigrationRole(
  runtimeConfig: RuntimeDatabaseConfig,
): Promise<void> {
  const result = await pool.query<{
    current_user: string;
    current_database: string;
    unsafe: boolean;
    unowned_tables: number;
  }>(`
    select current_user, current_database(),
           role.rolsuper or role.rolbypassrls or role.rolcreatedb
             or role.rolcreaterole or role.rolreplication as unsafe,
           (select count(*)::int
              from pg_class relation
              join pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and pg_get_userbyid(relation.relowner) <> current_user) as unowned_tables
      from pg_roles role
     where role.rolname = current_user
  `);
  const posture = result.rows[0];
  const runtimeUrl = new URL(runtimeConfig.connectionString);
  if (!env.OPENBOOKS_DB_URL?.trim()) {
    throw new Error("constrained schema-owner migration requires OPENBOOKS_DB_URL (the migration login)");
  }
  const migrationUrl = new URL(env.OPENBOOKS_DB_URL);
  // Fail closed: the escape hatch this flag opens (migrating as the schema
  // owner instead of a dedicated migration login) must never collapse the
  // migration and runtime logins into one outside explicit development/test
  // environments. Same-role constrained runs in production are how the
  // application ends up serving as the schema owner. An unset NODE_ENV (a
  // hand-run maintenance script) is treated as production. The rule itself
  // lives in constrainedSchemaOwnerRefusal so the posture has a behavioral
  // test; this stays a thin query-and-throw boundary.
  const refusal = constrainedSchemaOwnerRefusal(
    posture,
    migrationUrl,
    runtimeUrl,
    runtimeConfig.roleName,
    process.env.NODE_ENV,
  );
  if (refusal) throw new Error(refusal);
  // The predicate refuses an absent posture above, so reaching here proves
  // the row exists; re-assert it by name for the log line instead of
  // asserting non-null.
  if (!posture) {
    throw new Error(
      "constrained schema-owner migration requires a readable current-user role row and found none — " +
        "ask the database host to repair the provisioning in docs/operations/communal-postgres.md, then retry bootstrap",
    );
  }
  console.log(
    `[bootstrap] constrained schema owner ${posture.current_user} verified for migration-only mode`,
  );
}

/**
 * The constrained migration login cannot create roles (it is deliberately
 * unprivileged), so the runtime login must already exist. Refuse with the
 * exact host step instead of failing later on the first GRANT.
 */
export async function requireRuntimeLoginRole(config: RuntimeDatabaseConfig): Promise<void> {
  const existing = await pool.query<{ login: boolean }>(
    "select rolcanlogin as login from pg_roles where rolname = $1",
    [config.roleName],
  );
  if (!existing.rows[0]?.login) {
    throw new Error(
      `[bootstrap] runtime role ${config.roleName} does not exist with LOGIN; ` +
        `ask the database host to provision it per docs/operations/communal-postgres.md ` +
        `(CREATE ROLE ${config.roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION ` +
        `PASSWORD '<at least 24 characters>'; GRANT CONNECT, TEMPORARY ON DATABASE <database> TO ${config.roleName}), ` +
        `then retry bootstrap`,
    );
  }
}

/**
 * Verify-only check for the dedicated cross-tenant (BYPASSRLS) login. Used
 * wherever bootstrap may not create roles (pre-created and constrained
 * modes) and for a bypass URL that aliases the migration-owner or runtime
 * login (ephemeral/test posture), which must never be altered. Mirrors the
 * production startup predicate in engine/src/platform/db.ts: the login must
 * hold BYPASSRLS, except a superuser stands in only in explicit local
 * environments. Refusals name the host provisioning step, not a later GRANT
 * failure.
 */
export async function requireBypassLoginRole(config: RuntimeDatabaseConfig): Promise<void> {
  const existing = await pool.query<{ login: boolean; bypassrls: boolean; superuser: boolean }>(
    "select rolcanlogin as login, rolbypassrls as bypassrls, rolsuper as superuser from pg_roles where rolname = $1",
    [config.roleName],
  );
  const row = existing.rows[0];
  if (!row?.login) {
    throw new Error(
      `[bootstrap] bypass role ${config.roleName} does not exist with LOGIN; ` +
        `ask the database host to provision the dedicated cross-tenant login per docs/operations/communal-postgres.md ` +
        `(CREATE ROLE ${config.roleName} LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION ` +
        `PASSWORD '<at least 24 characters>'; GRANT CONNECT, TEMPORARY ON DATABASE <database> TO ${config.roleName} ` +
        `plus the application-object grants in that document), then retry bootstrap`,
    );
  }
  const localSuperuserFallback = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  if (!row.bypassrls && !(localSuperuserFallback && row.superuser)) {
    throw new Error(
      `[bootstrap] bypass role ${config.roleName} lacks BYPASSRLS; the cross-tenant login must hold BYPASSRLS ` +
        `(NOSUPERUSER, dedicated — never the runtime login); provision it per docs/operations/communal-postgres.md, ` +
        `then retry bootstrap`,
    );
  }
}
/**
 * Install and verify the tenant-isolation policies.
 *
 * `environments.sql` creates the `org_isolation` policy for every base table
 * carrying `org_id`, so its job is to cover tables that did not exist when it
 * last ran. The file digest plus a live catalog drift check provide both
 * properties we need: changed policy code and newly added/unprotected tables
 * trigger a refresh, while an ordinary container restart performs no
 * AccessExclusive table-lock sweep.
 */
export async function applyRowLevelSecurity(): Promise<void> {
  const file = join(migrationsDir, "environments.sql");
  const content = readFileSync(file, "utf8");
  const digest = sha256(content);
  const state = (await db.execute<{
      applied_digest: string | null;
      catalog_drift: boolean;
    }>(sql`
    select
      (select sha256
         from public._applied_migrations
        where filename = 'environments.sql') as applied_digest,
      exists (
        select 1
          from pg_class relation
          join pg_namespace namespace_row
            on namespace_row.oid = relation.relnamespace
         where namespace_row.nspname = 'public'
           and relation.relkind = 'r'
           and exists (
             select 1
               from information_schema.columns column_row
              where column_row.table_schema = 'public'
                and column_row.table_name = relation.relname
                and column_row.column_name = 'org_id'
           )
           and relation.relname not in ('sandboxes', 'user_org_access')
           and (
             not relation.relrowsecurity
             or not relation.relforcerowsecurity
             or not exists (
               select 1
                 from pg_policy policy
                where policy.polrelid = relation.oid
                  and policy.polname = 'org_isolation'
                  and obj_description(policy.oid, 'pg_policy')
                    = 'openbooks:org_isolation:v1'
             )
           )
      )
      or exists (
        select 1
          from pg_constraint
         where contype = 'f'
           and connamespace = 'public'::regnamespace
           and not condeferrable
      )
      or exists (
        select 1
          from pg_class relation
          join pg_namespace namespace_row
            on namespace_row.oid = relation.relnamespace
         where namespace_row.nspname = 'public'
           and relation.relname = 'sandboxes'
           and (
             not relation.relrowsecurity
             or not relation.relforcerowsecurity
             or not exists (
               select 1
                 from pg_policy policy
                where policy.polrelid = relation.oid
                  and policy.polname = 'sandbox_isolation'
                  and obj_description(policy.oid, 'pg_policy')
                    = 'openbooks:sandbox_isolation:v2'
             )
           )
      ) as catalog_drift
  `));
  const policyState = state.rows[0]!;
  if (policyState.applied_digest !== digest || policyState.catalog_drift) {
    console.log("[bootstrap] refreshing row-level security catalog");
    // Long DDL like the migrations above: no 120s client cap. Previously this
    // failure surfaced raw, so a client-side "Query read timeout" reached the
    // operator with neither cause nor remedy.
    const started = Date.now();
    const rlsClient = await connectMigrationClient();
    try {
      await rlsClient.query(content);
    } catch (err) {
      throw new Error(
        describeBootstrapMigrationFailure("environments.sql", err, Date.now() - started),
      );
    } finally {
      await releaseMigrationClient(rlsClient);
    }
    await db.execute(sql`
      insert into public._applied_migrations (filename, sha256)
      values ('environments.sql', ${digest})
      on conflict (filename) do update
        set sha256 = excluded.sha256,
            applied_at = now()
    `);
  }
  // Three conditions, not one. ENABLE alone is not isolation: without FORCE
  // the table OWNER is exempt, and the owning role is what CI and several
  // tooling paths connect as -- so an unprotected table looks protected in
  // every test. And a table with RLS on but no policy denies everyone, which
  // is a different failure that also must not reach a booting app.
  const unprotected = (await db.execute<{ table_name: string; reason: string }>(sql`
    select c.relname as table_name,
           case
             when not c.relrowsecurity then 'row-level security not enabled'
             when not c.relforcerowsecurity then 'FORCE not set (table owner would bypass)'
             else 'no policy defined'
           end as reason
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and exists (
         select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.relname
            and col.column_name = 'org_id')
       and (
         not c.relrowsecurity
         or not c.relforcerowsecurity
         or not exists (
           select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = c.relname)
       )
  `));
  // Fail loudly rather than booting an app whose tenant isolation has a hole.
  if (unprotected.rows.length > 0) {
    throw new Error(
      `row-level security incomplete on: ${unprotected.rows.map((r) => `${r.table_name} (${r.reason})`).join(", ")}`,
    );
  }
  console.log(
    "[bootstrap] row-level security verified on every org-scoped table",
  );
}

// Create the runtime database role (and reassert its safe posture) if it does
// not yet exist. This must run BEFORE migrations are applied: forward
// migrations may reference the runtime role directly (e.g. an RLS policy
// targeted `TO <runtime role>`), and PostgreSQL requires the role to exist at
// DDL time. Mirrors the openbooks_read pre-creation below migrate because
// migrations also grant privileges to those roles. Idempotent — safe to call
// again after migrate to grant access to newly created relations.
export async function ensureRuntimeRoleExists(
  config: RuntimeDatabaseConfig,
): Promise<void> {
  const role = await quoted(config.roleName, "identifier");
  const password = await quoted(config.password, "literal");
  const existing = await pool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = $1)",
    [config.roleName],
  );
  if (!existing.rows[0]!.exists) {
    await pool.query(`create role ${role} login password ${password}`);
  }
  // Reassert every prohibited cluster privilege on every deployment. A role
  // that was accidentally elevated must be made safe before traffic starts.
  try {
    await pool.query(
      `alter role ${role} login inherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password ${password}`,
    );
  } catch (err) {
    // A re-run over the transferred test login runs without role privileges
    // (only a superuser or CREATEROLE may alter roles, and the transferred
    // login is neither). Converge instead of enforcing — but a drifted posture
    // still fails loudly. Password rotation likewise requires a privileged run.
    if ((err as { code?: string }).code !== "42501") throw err;
    const posture = await pool.query<{ safe: boolean }>(
      `select (rolcanlogin and rolinherit and not rolsuper and not rolbypassrls
                 and not rolcreatedb and not rolcreaterole and not rolreplication) as safe
         from pg_roles where rolname = $1`,
      [config.roleName],
    );
    if (!posture.rows[0]?.safe) {
      throw new Error(
        `[bootstrap] cannot enforce safe posture on role ${config.roleName} without privilege; re-run as a superuser`,
      );
    }
    console.log(
      `[bootstrap] runtime role ${config.roleName} posture already safe; not re-enforced without privilege (password rotation needs a privileged run)`,
    );
  }
}

// True when the bypass URL aliases the migration-owner login bootstrap runs
// as, or the runtime login: there is no dedicated cross-tenant role to
// create or alter, so the ensure path degrades to the verify-only check
// (which still refuses a login that cannot bypass, by name).
async function bypassRoleIsAliased(
  config: RuntimeDatabaseConfig,
  runtimeRoleName: string | null,
): Promise<boolean> {
  if (runtimeRoleName && config.roleName === runtimeRoleName) return true;
  const me = await pool.query<{ me: string }>("select current_user as me");
  return config.roleName === me.rows[0]!.me;
}

// Create the dedicated cross-tenant (BYPASSRLS) login — and reassert its
// safe posture — when automatic provisioning owns role management. Mirrors
// ensureRuntimeRoleExists with BYPASSRLS in place of NOBYPASSRLS: the login
// defeats FORCE RLS by design, so it stays least-privilege everywhere else
// (NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION) and dedicated
// (never the runtime login). Idempotent; aliased URLs verify instead of
// altering the shared login.
export async function ensureBypassRoleExists(
  config: RuntimeDatabaseConfig,
  runtimeRoleName: string | null,
): Promise<boolean> {
  if (await bypassRoleIsAliased(config, runtimeRoleName)) {
    await requireBypassLoginRole(config);
    return false;
  }
  if (config.password.length < 24) {
    throw new Error("the bypass database password must contain at least 24 characters");
  }
  const role = await quoted(config.roleName, "identifier");
  const password = await quoted(config.password, "literal");
  const existing = await pool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = $1)",
    [config.roleName],
  );
  if (!existing.rows[0]!.exists) {
    await pool.query(`create role ${role} login password ${password}`);
  }
  // Reassert every prohibited cluster privilege on every deployment, keeping
  // BYPASSRLS as the single deliberate grant. Same privilege-escalation
  // discipline as the runtime role: without role privileges (42501) converge
  // instead of enforcing, but a drifted posture still fails loudly.
  try {
    await pool.query(
      `alter role ${role} login inherit nosuperuser bypassrls nocreatedb nocreaterole noreplication password ${password}`,
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "42501") throw err;
    const posture = await pool.query<{ safe: boolean }>(
      `select (rolcanlogin and rolinherit and not rolsuper and rolbypassrls
                 and not rolcreatedb and not rolcreaterole and not rolreplication) as safe
         from pg_roles where rolname = $1`,
      [config.roleName],
    );
    if (!posture.rows[0]?.safe) {
      throw new Error(
        `[bootstrap] cannot enforce safe posture on role ${config.roleName} without privilege; re-run as a superuser`,
      );
    }
    console.log(
      `[bootstrap] bypass role ${config.roleName} posture already safe; not re-enforced without privilege (password rotation needs a privileged run)`,
    );
  }
  return true;
}

// Converge the dedicated cross-tenant login's application-object rights to
// the runtime login's: BYPASSRLS changes which rows RLS hides, not which
// objects the login may touch, so it needs no more and no less. Never runs
// on an aliased URL (bypass naming the owner or runtime login): revoking
// function EXECUTE from a shared login could strip rights the installer
// itself needs. Callers verify aliased logins with requireBypassLoginRole.
export async function ensureBypassObjectGrants(
  config: RuntimeDatabaseConfig,
  runtimeRoleName: string | null,
): Promise<void> {
  if (await bypassRoleIsAliased(config, runtimeRoleName)) return;
  const role = await quoted(config.roleName, "identifier");
  await pool.query(`grant usage on schema public to ${role}`);
  await pool.query(
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
  );
  await pool.query(
    `grant usage, select, update on all sequences in schema public to ${role}`,
  );
  // Same SECURITY DEFINER discipline as the runtime login: the public schema
  // holds tightly controlled maintenance functions the cross-tenant login
  // must not execute. The governed-query surface stays out: the bypass pool
  // never SET ROLEs to openbooks_read and never runs the query-catalog
  // maintenance function.
  await revokeRuntimeFunctionExecute(pool, config.roleName);
  await pool.query(
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`,
  );
  await pool.query(
    `alter default privileges in schema public grant usage, select, update on sequences to ${role}`,
  );
}

// Automatic mode: create the dedicated cross-tenant login when absent,
// connect it to the database, converge its object grants, and grant the
// tenant-identity plumbing. Aliased URLs verify instead of writing.
export async function ensureBypassDatabaseRole(
  config: RuntimeDatabaseConfig,
  runtimeRoleName: string | null,
): Promise<void> {
  const dedicated = await ensureBypassRoleExists(config, runtimeRoleName);
  if (!dedicated) return;
  const role = await quoted(config.roleName, "identifier");
  const databaseResult = await pool.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  const database = await quoted(databaseResult.rows[0]!.database_name, "identifier");
  await pool.query(`grant connect, temporary on database ${database} to ${role}`);
  await ensureBypassObjectGrants(config, runtimeRoleName);
  // Bypass sessions establish tenant identity through the same set_config
  // plumbing. A transferred test owner may only verify the existing grant.
  try {
    await pool.query(
      `grant execute on function pg_catalog.set_config(text, text, boolean) to ${role}`,
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "42501") throw err;
    const granted = await pool.query<{ ok: boolean }>(
      `select has_function_privilege($1, 'pg_catalog.set_config(text, text, boolean)', 'EXECUTE') as ok`,
      [config.roleName],
    );
    if (!granted.rows[0]?.ok) throw err;
  }
  console.log(
    `[bootstrap] bypass database role ${config.roleName} constrained and granted application privileges`,
  );
}

export async function ensureRuntimeDatabaseRole(
  config: RuntimeDatabaseConfig,
  precreated = false,
): Promise<void> {
  const role = await quoted(config.roleName, "identifier");
  const databaseResult = await pool.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  const database = await quoted(databaseResult.rows[0]!.database_name, "identifier");
  if (!precreated) {
    await ensureRuntimeRoleExists(config);
    await pool.query(`grant connect, temporary on database ${database} to ${role}`);
  }
  await pool.query(`grant usage on schema public to ${role}`);
  await pool.query(
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
  );
  await pool.query(
    `grant usage, select, update on all sequences in schema public to ${role}`,
  );
  // Function execution is inherited only from deliberately retained PUBLIC
  // grants. Never blanket-grant the runtime role: the public schema also holds
  // tightly controlled SECURITY DEFINER maintenance functions. The revoke is
  // issued per function, skipping owner-held entries: after the ownership
  // transfer the runtime role owns these functions, and a blanket revoke
  // would strip its own entry, collapsing the ACL to explicitly empty —
  // which denies EXECUTE even to the owner.
  await revokeRuntimeFunctionExecute(pool, config.roleName);
  // Retain the automatic mode's catalog-refresh grant for legacy constrained
  // owners and migration-replay tooling. In host-managed mode, only the
  // separate migration owner needs this maintenance function.
  if (!precreated) {
    await pool.query(
      `grant execute on function public.openbooks_refresh_query_catalog() to ${role}`,
    );
  }
  // The application needs set_config to establish tenant identity. Hosted
  // preflight verifies EXECUTE without administering pg_catalog ACLs. In
  // automatic mode, a transferred test owner may only verify an existing
  // grant (including PostgreSQL's default PUBLIC grant).
  if (!precreated) {
    try {
      await pool.query(
        `grant execute on function pg_catalog.set_config(text, text, boolean) to ${role}`,
      );
    } catch (err) {
      if ((err as { code?: string }).code !== "42501") throw err;
      const granted = await pool.query<{ ok: boolean }>(
        `select has_function_privilege($1, 'pg_catalog.set_config(text, text, boolean)', 'EXECUTE') as ok`,
        [config.roleName],
      );
      if (!granted.rows[0]?.ok) throw err;
    }
  }
  await pool.query(
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`,
  );
  await pool.query(
    `alter default privileges in schema public grant usage, select, update on sequences to ${role}`,
  );
  console.log(
    `[bootstrap] runtime database role ${config.roleName} constrained and granted application privileges`,
  );
}

export async function verifyRuntimeDatabaseRole(
  config: RuntimeDatabaseConfig,
  orgId: string,
): Promise<void> {
  const runtimePool = new pg.Pool({
    connectionString: config.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const client = await runtimePool.connect();
    try {
      const role = await client.query<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        unsafeRoles: string[];
      }>(`select current_user,
                 role_row.rolsuper,
                 role_row.rolbypassrls,
                 role_row.rolcreatedb,
                 role_row.rolcreaterole,
                 role_row.rolreplication,
                 array(
                   select assumable.rolname
                     from pg_roles assumable
                    where assumable.rolname <> current_user
                      and pg_has_role(current_user, assumable.oid, 'MEMBER')
                      and (
                        assumable.rolsuper
                        or assumable.rolbypassrls
                        or assumable.rolcreatedb
                        or assumable.rolcreaterole
                        or assumable.rolreplication
                        or assumable.rolname in (
                          'pg_read_server_files',
                          'pg_write_server_files',
                          'pg_execute_server_program'
                        )
                      )
                    order by assumable.rolname
                 )::text[] as "unsafeRoles"
            from pg_roles role_row
           where role_row.rolname = current_user`);
      const posture = role.rows[0];
      if (
        !posture ||
        posture.current_user !== config.roleName ||
        posture.rolsuper ||
        posture.rolbypassrls ||
        posture.rolcreatedb ||
        posture.rolcreaterole ||
        posture.rolreplication ||
        posture.unsafeRoles.length > 0
      ) {
        throw new Error(
          `unsafe runtime database role: ${JSON.stringify(posture ?? null)}`,
        );
      }

      await client.query(
        "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'off', false)",
      );
      const denied = await client.query<{ count: string }>("select count(*) from orgs");
      if (denied.rows[0]?.count !== "0") {
        throw new Error(
          `RLS fail-closed proof failed: unscoped runtime role saw ${denied.rows[0]?.count ?? "unknown"} organizations`,
        );
      }

      await client.query(
        "select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'off', false)",
        [orgId],
      );
      const allowed = await client.query<{ id: string }>(
        "select id from orgs where id = $1",
        [orgId],
      );
      if (allowed.rows.length !== 1) {
        throw new Error("RLS tenant proof failed: runtime role could not read its selected organization");
      }
      // Exercise the real definer/temporary-context boundary from the runtime
      // login. Checking membership from the migration connection misses both
      // unusable SET grants and a definer owner unable to read runtime context.
      await client.query("create temporary table openbooks_query_context (org_id uuid not null)");
      await client.query("insert into pg_temp.openbooks_query_context values ($1)", [orgId]);
      try {
        await client.query("begin transaction read only");
        await client.query("set local role openbooks_read");
        const context = await client.query<{ org: string }>("select public.openbooks_query_org_id() as org");
        if (context.rows[0]?.org !== orgId) throw new Error("governed query context did not resolve its organization");
        await client.query("select id from openbooks_query.accounting_books limit 1");
        // Every governed relation must be readable by the query role: a view
        // created after a grant loop (0338's payment_pending_clawbacks) left the
        // console silently short one relation while every other probe passed.
        const unreadable = await client.query<{ relname: string }>(
          `select c.relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'openbooks_query'
              and c.relkind in ('r', 'v', 'm', 'p', 'f')
              and not has_table_privilege('openbooks_read', c.oid, 'SELECT')
            order by c.relname`,
        );
        if (unreadable.rows.length > 0) {
          throw new Error(
            `governed query relations not readable by openbooks_read: ${unreadable.rows.map((row) => row.relname).join(", ")}`,
          );
        }
      } catch (error) {
        throw new Error("[bootstrap] runtime governed-query verification failed; verify the read-role SET grant and migration-owner inheritance of the runtime role in docs/operations/communal-postgres.md", { cause: error });
      } finally {
        await client.query("rollback");
      }
      console.log(
        `[bootstrap] runtime database role ${config.roleName} verified: NOSUPERUSER, NOBYPASSRLS, fail-closed RLS`,
      );
    } finally {
      client.release();
    }
  } finally {
    await runtimePool.end();
  }
}

// Test-database ownership transfer (CI/testdb provisioning only — refused in
// production). CI service containers log in as the initdb bootstrap superuser,
// and PostgreSQL exempts superusers from every RLS policy unconditionally
// (FORCE ROW LEVEL SECURITY constrains owners, never superusers; and PG16 even
// refuses to desuperuser the bootstrap login). So a test login that IS the
// bootstrap user can never be RLS-subject — and every isolation assertion
// through the app pool is vacuous there. The uniform target posture is a
// CONSTRAINED OWNER (exactly what long-lived installs already run as): after
// the privileged steps (extensions, roles, migrations) the executor hands
// every app-schema object plus database and schema ownership to the
// constrained runtime role, so the test login owns every object it must DDL
// while its sessions stay fully RLS-subject under FORCE.
//
// The loop is scoped to this database's two app schemas (a cluster-wide
// REASSIGN OWNED would also be complete, but it refuses outright when the
// bootstrap login owns system-required objects — always true via the template
// databases' boilerplate — so it cannot serve here). The explicit opt-in
// variable plus the production refusal below are the interlocks: never set it
// on a shared or production database.
export async function transferTestOwnershipToRuntimeRole(
  config: RuntimeDatabaseConfig,
): Promise<void> {
  if (env.OPENBOOKS_TEST_OWNERSHIP_TRANSFER !== "1") return;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "[bootstrap] OPENBOOKS_TEST_OWNERSHIP_TRANSFER is refused in production",
    );
  }
  const loginResult = await pool.query<{ login: string }>(
    "select current_user as login",
  );
  const login = loginResult.rows[0]!.login;
  if (login === config.roleName) return;
  const superResult = await pool.query<{ superuser: boolean }>(
    "select rolsuper as superuser from pg_roles where rolname = current_user",
  );
  if (!superResult.rows[0]?.superuser) {
    // A re-run over the test login (e.g. local bootstrap after the template
    // transferred) cannot reassign anything; converge instead of enforcing and
    // fail loudly with instructions when the posture drifted.
    await verifyTestOwnership(config);
    console.log(
      `[bootstrap] ownership transfer skipped without privilege; runtime role ${config.roleName} already owns the RLS nexus`,
    );
    return;
  }
  // Scoped, catalog-driven ownership loop over THIS database only. REASSIGN
  // OWNED would be complete by construction but it is cluster-wide and refuses
  // outright when the bootstrap login owns system-required objects (it always
  // does: the template databases' boilerplate), so it cannot serve here. The
  // loop covers every class with an isolation nexus — base tables (RLS),
  // views, and SECURITY DEFINER functions (which execute as their owner) —
  // plus sequences and matviews for uniformity. Types are intentionally left
  // alone: type ownership has no RLS or execution nexus, and array types
  // cannot be altered directly. Statements are fully quoted server-side.
  const stmts = await pool.query<{ stmt: string }>(
    `select (case c.relkind
               when 'v' then 'alter view '
               when 'm' then 'alter materialized view '
               when 'S' then 'alter sequence '
               when 'f' then 'alter foreign table '
               else 'alter table ' end)
              || format('%I.%I', n.nspname, c.relname)
              || ' owner to ' || quote_ident($1) as stmt
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'openbooks_query')
        and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
        and pg_get_userbyid(c.relowner) <> $1
        -- A serial/identity sequence is LINKED to its column: PostgreSQL
        -- refuses ALTER SEQUENCE ... OWNER TO on it (SQLSTATE 0A000) unless
        -- the owning table has already changed hands, and this list has no
        -- guaranteed order. Skip them: altering the table carries its
        -- sequences with it, so they still end up on the runtime role.
        and not (
          c.relkind = 'S'
          and exists (
            select 1 from pg_depend d
             where d.classid = 'pg_class'::regclass
               and d.objid = c.oid
               and d.refclassid = 'pg_class'::regclass
               and d.deptype in ('a', 'i')
          )
        )
      union all
     select 'alter function ' || p.oid::regprocedure::text
              || ' owner to ' || quote_ident($1) as stmt
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'openbooks_query')
        and pg_get_userbyid(p.proowner) <> $1
        -- RLS-GUC-ESCALATION (0399): public.app_bypass_rls_active() recognizes
        -- the migration/installer owner BY OWNERSHIP (pg_has_role against its
        -- proowner), so transferring it to the runtime role would make the
        -- runtime login satisfy the predicate and silently re-open every
        -- tenant policy. It stays with the migration executor; the runtime
        -- role still executes it through the retained PUBLIC grant, and the
        -- ownership verifier ignores SECURITY INVOKER functions.
        and not (n.nspname = 'public' and p.proname = 'app_bypass_rls_active')`,
    [config.roleName],
  );
  for (const { stmt } of stmts.rows) {
    await pool.query(stmt);
  }
  const runtimeRole = await quoted(config.roleName, "identifier");
  const dbResult = await pool.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  const database = await quoted(dbResult.rows[0]!.database_name, "identifier");
  await pool.query(`alter database ${database} owner to ${runtimeRole}`);
  await pool.query(`alter schema public owner to ${runtimeRole}`);
  await pool.query(`alter schema openbooks_query owner to ${runtimeRole}`);
  await verifyTestOwnership(config);
  console.log(
    `[bootstrap] test ownership transferred to ${config.roleName} (${stmts.rows.length} objects plus database and schemas): constrained owner, RLS-subject sessions`,
  );
}

/**
 * Positive ownership proof over the RLS nexus: every org-scoped base table,
 * every governed view, every SECURITY DEFINER function (which executes as its
 * owner — a superuser-owned definer is an exempt path that survives FORCE),
 * and both app schemas (future CREATEs vest in the schema owner) must be
 * owned by the runtime role. Deliberately not a census — provisioning
 * bookkeeping outside the app schema (e.g. testdb's own build record, written
 * after bootstrap) and type ownership (no RLS or execution nexus) are
 * ignored; the isolation surface is what must be fully vested.
 */
async function verifyTestOwnership(
  config: RuntimeDatabaseConfig,
): Promise<void> {
  const offenders = await pool.query<{ object_name: string }>(
    `select c.relname as object_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles r on r.oid = c.relowner
      where ((n.nspname = 'public' and c.relkind in ('r', 'p')
              and exists (
                select 1 from pg_attribute a
                 where a.attrelid = c.oid and a.attname = 'org_id'))
             or (n.nspname = 'openbooks_query' and c.relkind = 'v'))
        and r.rolname <> $1
      union all
     select p.oid::regprocedure::text as object_name
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_roles r on r.oid = p.proowner
      where n.nspname in ('public', 'openbooks_query')
        and p.prosecdef
        and r.rolname <> $1
      union all
     select 'schema ' || n.nspname as object_name
       from pg_namespace n
       join pg_roles r on r.oid = n.nspowner
      where n.nspname in ('public', 'openbooks_query')
        and r.rolname <> $1
      order by 1`,
    [config.roleName],
  );
  if (offenders.rows.length > 0) {
    throw new Error(
      `[bootstrap] ownership transfer incomplete; RLS nexus objects not owned by ${config.roleName}: ` +
        offenders.rows.map((r) => r.object_name).join(", "),
    );
  }
}

export async function ensureReadRole(runtimeRoleName?: string): Promise<void> {
  const steps: [string, string][] = [
    [
      "create role",
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = 'openbooks_read') then
           create role openbooks_read nologin;
         end if;
       end $$;`,
    ],
    [
      "grant to bootstrap user",
      `do $$ begin
         if not pg_has_role(current_user, 'openbooks_read', 'SET') then
           grant openbooks_read to current_user with set true;
         end if;
       end $$;`,
    ],
  ];
  if (runtimeRoleName) {
    const runtimeRole = await quoted(runtimeRoleName, "identifier");
    const runtimeLiteral = await quoted(runtimeRoleName, "literal");
    // Conditional like the bootstrap-user grant above: a re-run over the
    // transferred test login cannot administer memberships, so skip when it
    // already has SET permission instead of requiring an ADMIN OPTION grant.
    steps.push(["grant to runtime user", `do $$ begin
         if not pg_has_role(${runtimeLiteral}, 'openbooks_read', 'SET') then
           grant openbooks_read to ${runtimeRole} with set true;
         end if;
       end $$;`]);
  }
  for (const [label, stmt] of steps) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      throw new Error(
        `[bootstrap] openbooks_read ${label} failed: ${(err as Error).message}`,
      );
    }
  }
  await verifyReadRoleAssumption(pool, "bootstrap login");
  console.log("[bootstrap] openbooks_read role usable");
}
