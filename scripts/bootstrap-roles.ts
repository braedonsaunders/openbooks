/** Host-managed role provisioning. These checks never create/alter roles or memberships. */
import pg from "pg";

export type RuntimeDatabaseConfig = {
  connectionString: string;
  roleName: string;
  password: string;
};

export function precreatedRolesEnabled(env: Record<string, string | undefined>): boolean {
  const mode = env.OPENBOOKS_PRECREATED_ROLES;
  if (mode === undefined || mode === "0") return false;
  if (mode !== "1") throw new Error("OPENBOOKS_PRECREATED_ROLES must be 0 or 1");
  if (env.OPENBOOKS_BOOTSTRAP !== "1" || !env.OPENBOOKS_MIGRATION_DB_URL || !env.OPENBOOKS_RUNTIME_DB_URL) {
    throw new Error("OPENBOOKS_PRECREATED_ROLES=1 requires OPENBOOKS_BOOTSTRAP=1, OPENBOOKS_MIGRATION_DB_URL and OPENBOOKS_RUNTIME_DB_URL; see docs/operations/communal-postgres.md");
  }
  if (env.OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION === "1" || env.OPENBOOKS_TEST_OWNERSHIP_TRANSFER === "1") {
    throw new Error("pre-created roles cannot be combined with constrained schema-owner migration or test ownership transfer");
  }
  const owner = new URL(env.OPENBOOKS_MIGRATION_DB_URL);
  const runtime = new URL(env.OPENBOOKS_RUNTIME_DB_URL);
  if (![owner, runtime].every((url) => ["postgres:", "postgresql:"].includes(url.protocol))) {
    throw new Error("migration and runtime URLs must be PostgreSQL URLs");
  }
  if (owner.hostname !== runtime.hostname || (owner.port || "5432") !== (runtime.port || "5432") ||
      decodeURIComponent(owner.pathname) !== decodeURIComponent(runtime.pathname)) {
    throw new Error("pre-created migration and runtime URLs must target the same host, port and database");
  }
  if (decodeURIComponent(owner.username) === decodeURIComponent(runtime.username)) {
    throw new Error("pre-created roles require separate migration-owner and runtime logins; ask the host to provision both as described in docs/operations/communal-postgres.md");
  }
  return true;
}

function refusal(message: string): Error {
  return new Error(`[bootstrap] ${message}; ask the database host to repair the provisioning in docs/operations/communal-postgres.md, then retry bootstrap`);
}

/** Probe SET itself: inherited privileges (USAGE) do not imply SET permission on PG16+. */
export async function verifyReadRoleAssumption(pool: pg.Pool, label: string): Promise<void> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("begin");
    await client.query("set local role openbooks_read");
  } catch {
    throw refusal(`${label} cannot SET ROLE openbooks_read; the role must exist and membership must permit SET ROLE`);
  } finally {
    try { await client.query("rollback"); } catch { discard = true; }
    client.release(discard);
  }
}

async function verifyLogin(pool: pg.Pool, label: string): Promise<string> {
  const result = await pool.query<{ name: string; unsafe: string[] }>(`
    select current_user as name, array(
      select r.rolname from pg_roles r
       where pg_has_role(current_user, r.oid, 'MEMBER')
         and (r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication
           or r.rolname in ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program',
                            'pg_read_all_data', 'pg_write_all_data'))
    ) as unsafe
  `);
  const row = result.rows[0];
  if (!row || row.unsafe.length) throw refusal(`${label} has unsafe role privileges: ${row?.unsafe.join(", ") || "posture unavailable"}`);
  return row.name;
}

async function verifyRuntimeOwnership(migration: pg.Pool, runtimeRole: string): Promise<void> {
  const result = await migration.query<{ object: string }>(`
    select 'database ' || datname as object from pg_database
     where datname = current_database() and pg_has_role($1, datdba, 'MEMBER')
    union all
    select 'schema ' || nspname from pg_namespace
     where nspname in ('public', 'openbooks_query') and
       (pg_has_role($1, nspowner, 'MEMBER') or has_schema_privilege($1, oid, 'CREATE'))
    union all
    select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'openbooks_query') and pg_has_role($1, c.relowner, 'MEMBER')
    union all
    select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'openbooks_query') and pg_has_role($1, p.proowner, 'MEMBER')
    limit 5
  `, [runtimeRole]);
  const create = await migration.query<{ allowed: boolean }>(
    "select has_database_privilege($1, current_database(), 'CREATE') as allowed", [runtimeRole],
  );
  if (result.rows.length || create.rows[0]?.allowed) {
    throw refusal(`runtime role ${runtimeRole} must not own application objects, inherit their owners, or have CREATE privileges (${result.rows.map((r) => r.object).join(", ") || "database CREATE"})`);
  }
}

export async function verifyPrecreatedRoles(migration: pg.Pool, config: RuntimeDatabaseConfig): Promise<void> {
  const owner = await verifyLogin(migration, "migration login");
  const runtimeRole = await migration.query<{ login: boolean }>("select rolcanlogin as login from pg_roles where rolname = $1", [config.roleName]);
  if (!runtimeRole.rows[0]?.login) throw refusal(`runtime role ${config.roleName} must exist with LOGIN`);
  const read = await migration.query<{ safe: boolean }>(`
    select not (rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication)
      and not exists (select 1 from pg_auth_members where member = r.oid) as safe
      from pg_roles r where rolname = 'openbooks_read'
  `);
  if (!read.rows[0]?.safe) throw refusal("openbooks_read must exist as a restricted NOLOGIN role with no memberships in other roles");
  const privileges = await migration.query<{ owner_ok: boolean; inherits_runtime: boolean }>(`
    select has_database_privilege(current_user, current_database(), 'CREATE')
      and has_schema_privilege(current_user, 'public', 'CREATE') as owner_ok,
      pg_has_role(current_user, $1, 'USAGE') as inherits_runtime
  `, [config.roleName]);
  if (!privileges.rows[0]?.owner_ok) throw refusal(`migration role ${owner} requires CREATE on its database and public schema`);
  // The SECURITY DEFINER query-context helper is owned by the migrator and
  // must read the runtime-owned temporary context table. This inheritance is
  // deliberately one way: the runtime cannot assume or inherit its owner.
  if (!privileges.rows[0]?.inherits_runtime) throw refusal(`migration role ${owner} must inherit runtime role ${config.roleName} (GRANT runtime TO owner WITH INHERIT TRUE)`);
  const unowned = await migration.query<{ object: string }>(`
    select n.nspname || '.' || c.relname as object from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'openbooks_query') and c.relkind in ('r', 'p', 'v', 'm', 'S')
       and not pg_has_role(current_user, c.relowner, 'USAGE')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
                       and d.objid = c.oid and d.deptype = 'e') limit 5
  `);
  if (unowned.rows.length) throw refusal(`migration role ${owner} does not own application objects: ${unowned.rows.map((r) => r.object).join(", ")}`);
  const extensions = await migration.query<{ name: string }>(`
    select name from unnest(array['btree_gist', 'pgcrypto']) name
     where not exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
                       where e.extname = name and n.nspname = 'public')
  `);
  if (extensions.rows.length) throw refusal(`required extensions must be installed in public: ${extensions.rows.map((r) => r.name).join(", ")}`);
  await verifyRuntimeOwnership(migration, config.roleName);
  await verifyReadRoleAssumption(migration, `migration role ${owner}`);
  const runtime = new pg.Pool({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const login = await verifyLogin(runtime, "runtime login");
    if (login !== config.roleName || login === owner) throw refusal("runtime connection must authenticate as the separate configured application role");
    const capabilities = await runtime.query<{ temp: boolean; config: boolean }>(`
      select has_database_privilege(current_user, current_database(), 'TEMP') as temp,
             has_function_privilege(current_user, 'pg_catalog.set_config(text,text,boolean)', 'EXECUTE') as config
    `);
    if (!capabilities.rows[0]?.temp || !capabilities.rows[0]?.config) throw refusal(`runtime role ${login} requires database TEMP and EXECUTE on pg_catalog.set_config(text,text,boolean)`);
    await verifyReadRoleAssumption(runtime, `runtime role ${login}`);
  } finally { await runtime.end(); }
}

/** Check effective access (including PUBLIC), not just explicit grant rows. */
export async function verifyPrecreatedObjectAccess(migration: pg.Pool, config: RuntimeDatabaseConfig): Promise<void> {
  await verifyRuntimeOwnership(migration, config.roleName);
  const unsafe = await migration.query<{ object: string }>(`
    select n.nspname || '.' || c.relname as object from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'openbooks_query') and c.relkind in ('r', 'p', 'v', 'm')
       and (has_table_privilege('openbooks_read', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or (n.nspname = 'public' and has_table_privilege('openbooks_read', c.oid, 'SELECT')))
    union all
    select 'schema ' || nspname from pg_namespace where nspname in ('public', 'openbooks_query')
      and has_schema_privilege('openbooks_read', oid, 'CREATE')
    union all
    select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'openbooks_query') and p.prosecdef
       and p.oid <> 'public.openbooks_query_org_id()'::regprocedure
       and has_function_privilege('openbooks_read', p.oid, 'EXECUTE')
    limit 5
  `);
  if (unsafe.rows.length) throw refusal(`openbooks_read has access outside the governed read-only surface: ${unsafe.rows.map((r) => r.object).join(", ")}`);
  const missing = await migration.query<{ object: string }>(`
    select n.nspname || '.' || c.relname as object from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and not (has_table_privilege($1, c.oid, 'SELECT') and has_table_privilege($1, c.oid, 'INSERT')
         and has_table_privilege($1, c.oid, 'UPDATE') and has_table_privilege($1, c.oid, 'DELETE'))
    union all
    select 'openbooks_query.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'openbooks_query' and c.relkind = 'v'
       and not has_table_privilege('openbooks_read', c.oid, 'SELECT')
    limit 5
  `, [config.roleName]);
  if (missing.rows.length) throw refusal(`application or query-role object grants are incomplete: ${missing.rows.map((r) => r.object).join(", ")}`);
}
