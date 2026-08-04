/**
 * Deployment bootstrap — idempotent, runs before the web server starts.
 *
 *   1. Applies schema/migrations/generated/*.sql in filename order, tracked in
 *      _applied_migrations (skip-once semantics; a changed already-applied file
 *      logs a loud warning instead of re-running).
 *   2. Applies referential-integrity.sql + kernel-constraints.sql the same way,
 *      then verifies environments.sql (row-level security), applying it only
 *      when its version or live catalog coverage has changed.
 *   3. Ensures the SELECT-only `openbooks_read` role + grants (SQL workbench
 *      and user-script queries need it).
 *   4. Ensures an org, its primary accounting book, monthly accounting
 *      periods, and the built-in RBAC roles.
 *   5. Upserts the initial admin user from ADMIN_EMAIL / ADMIN_NAME /
 *      ADMIN_PASSWORD (skipped when unset).
 *
 * Run: npx tsx scripts/bootstrap.ts   (or the esbuild bundle in the image)
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, env, pool, withBypassContext } from "../engine/src/db.ts";
import { ensureCloseDefaults } from "../engine/src/close.ts";
import { SUPPORTED_CURRENCIES } from "../engine/src/currencies.ts";
import { seedProjectTypes } from "../engine/src/seed-project-types.ts";
import { BUILT_IN_ROLES } from "../web/lib/permissions.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "schema", "migrations");

type RuntimeDatabaseConfig = {
  connectionString: string;
  roleName: string;
  password: string;
};

function runtimeDatabaseConfig(): RuntimeDatabaseConfig | null {
  const connectionString = env.OPENBOOKS_RUNTIME_DB_URL?.trim();
  if (!connectionString) return null;
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("OPENBOOKS_RUNTIME_DB_URL must be a PostgreSQL URL");
  }
  const roleName = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) {
    throw new Error("OPENBOOKS_RUNTIME_DB_URL contains an invalid PostgreSQL role name");
  }
  if (password.length < 24) {
    throw new Error("the runtime database password must contain at least 24 characters");
  }
  return { connectionString, roleName, password };
}

async function quoted(value: string, kind: "identifier" | "literal"): Promise<string> {
  const fn = kind === "identifier" ? "quote_ident" : "quote_literal";
  const result = await pool.query<{ value: string }>(
    `select ${fn}($1) as value`,
    [value],
  );
  return result.rows[0]!.value;
}

async function assertConstrainedSchemaOwnerMigrationRole(
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
  const runtimeDatabase = decodeURIComponent(
    new URL(runtimeConfig.connectionString).pathname.replace(/^\//, ""),
  );
  if (
    !posture ||
    posture.current_user !== runtimeConfig.roleName ||
    posture.current_database !== runtimeDatabase ||
    posture.unsafe ||
    posture.unowned_tables !== 0
  ) {
    throw new Error(
      "constrained schema-owner migration requires a restricted role that owns every public table",
    );
  }
  console.log(
    `[bootstrap] constrained schema owner ${posture.current_user} verified for migration-only mode`,
  );
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function applyTracked(
  label: string,
  filename: string,
  content: string,
): Promise<void> {
  const digest = sha256(content);
  const seen = (await db.execute(sql`
    select sha256 from _applied_migrations where filename = ${filename}
  `)) as unknown as { rows: { sha256: string }[] };
  if (seen.rows.length > 0) {
    if (seen.rows[0].sha256 !== digest) {
      console.warn(
        `[bootstrap] WARNING: ${filename} changed after it was applied — new statements were NOT run. ` +
          `Reconcile manually, then update _applied_migrations.sha256.`,
      );
    }
    return;
  }
  console.log(`[bootstrap] applying ${label}: ${filename}`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(content);
    await client.query(
      "insert into _applied_migrations (filename, sha256) values ($1, $2)",
      [filename, digest],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw new Error(
      `[bootstrap] ${filename} failed: ${(err as Error).message}`,
    );
  } finally {
    client.release();
  }
}

async function migrate(): Promise<void> {
  // The id() column default across the whole schema — a plain SQL v7-UUID
  // generator (no extension). Must exist before the first CREATE TABLE.
  await db.execute(
    sql.raw(`
    CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
     RETURNS uuid
     LANGUAGE sql
     PARALLEL SAFE
    AS $fn$
      select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
        placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
        from 1 for 6), 52, 1), 53, 1), 'hex')::uuid
    $fn$;
  `),
  );
  await db.execute(sql`
    create table if not exists _applied_migrations (
      filename text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )
  `);
  const generated = readdirSync(join(migrationsDir, "generated"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of generated) {
    const filename = `generated/${f}`;
    const content = readFileSync(join(migrationsDir, "generated", f), "utf8");
    await applyTracked("migration", filename, content);
  }
  for (const f of [
    "referential-integrity.sql",
    "referential-integrity-v2.sql",
    "referential-integrity-v3.sql",
    "kernel-constraints.sql",
  ]) {
    await applyTracked(
      "constraints",
      f,
      readFileSync(join(migrationsDir, f), "utf8"),
    );
  }
  await applyRowLevelSecurity();
  await applyTracked(
    "constraints",
    "referential-integrity-v4.sql",
    readFileSync(
      join(migrationsDir, "referential-integrity-v4.sql"),
      "utf8",
    ),
  );
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
async function applyRowLevelSecurity(): Promise<void> {
  const file = join(migrationsDir, "environments.sql");
  const content = readFileSync(file, "utf8");
  const digest = sha256(content);
  const state = (await db.execute(sql`
    select
      (select sha256
         from _applied_migrations
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
                    = 'openbooks:sandbox_isolation:v1'
             )
           )
      ) as catalog_drift
  `)) as unknown as {
    rows: Array<{
      applied_digest: string | null;
      catalog_drift: boolean;
    }>;
  };
  const policyState = state.rows[0]!;
  if (policyState.applied_digest !== digest || policyState.catalog_drift) {
    console.log("[bootstrap] refreshing row-level security catalog");
    await pool.query(content);
    await db.execute(sql`
      insert into _applied_migrations (filename, sha256)
      values ('environments.sql', ${digest})
      on conflict (filename) do update
        set sha256 = excluded.sha256,
            applied_at = now()
    `);
  }
  const unprotected = (await db.execute(sql`
    select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and not c.relrowsecurity
       and exists (
         select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.relname
            and col.column_name = 'org_id')
  `)) as unknown as { rows: { table_name: string }[] };
  // Fail loudly rather than booting an app whose tenant isolation has a hole.
  if (unprotected.rows.length > 0) {
    throw new Error(
      `row-level security missing on: ${unprotected.rows.map((r) => r.table_name).join(", ")}`,
    );
  }
  console.log(
    "[bootstrap] row-level security verified on every org-scoped table",
  );
}

async function ensureRuntimeDatabaseRole(
  config: RuntimeDatabaseConfig,
): Promise<void> {
  const role = await quoted(config.roleName, "identifier");
  const password = await quoted(config.password, "literal");
  const databaseResult = await pool.query<{ database_name: string }>(
    "select current_database() as database_name",
  );
  const database = await quoted(databaseResult.rows[0]!.database_name, "identifier");
  const existing = await pool.query<{ exists: boolean }>(
    "select exists(select 1 from pg_roles where rolname = $1)",
    [config.roleName],
  );
  if (!existing.rows[0]!.exists) {
    await pool.query(`create role ${role} login password ${password}`);
  }
  // Reassert every prohibited cluster privilege on every deployment. A role
  // that was accidentally elevated must be made safe before traffic starts.
  await pool.query(
    `alter role ${role} login inherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password ${password}`,
  );
  await pool.query(`grant connect, temporary on database ${database} to ${role}`);
  await pool.query(`grant usage on schema public to ${role}`);
  await pool.query(
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
  );
  await pool.query(
    `grant usage, select, update on all sequences in schema public to ${role}`,
  );
  // Function execution is inherited only from deliberately retained PUBLIC
  // grants. Never blanket-grant the runtime role: the public schema also holds
  // tightly controlled SECURITY DEFINER maintenance functions.
  await pool.query(`revoke execute on all functions in schema public from ${role}`);
  // The application establishes tenant identity with connection-local GUCs.
  // This privilege belongs to the runtime login, never to openbooks_read; the
  // governed SQL console switches to openbooks_read before user SQL executes.
  await pool.query(
    `grant execute on function pg_catalog.set_config(text, text, boolean) to ${role}`,
  );
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

async function verifyRuntimeDatabaseRole(
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

async function ensureReadRole(runtimeRoleName?: string): Promise<void> {
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
         if not pg_has_role(current_user, 'openbooks_read', 'USAGE') then
           grant openbooks_read to current_user;
         end if;
       end $$;`,
    ],
  ];
  if (runtimeRoleName) {
    const runtimeRole = await quoted(runtimeRoleName, "identifier");
    steps.push(["grant to runtime user", `grant openbooks_read to ${runtimeRole}`]);
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
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role openbooks_read");
      await client.query("rollback");
      console.log("[bootstrap] openbooks_read role usable");
    } finally {
      client.release();
    }
  } catch {
    console.warn(
      "[bootstrap] WARNING: cannot assume openbooks_read — SQL workbench/user-script queries will fail",
    );
  }
}

async function ensureOrg(): Promise<string> {
  const existing = (await db.execute(
    sql`select id from orgs order by created_at limit 1`,
  )) as unknown as {
    rows: { id: string }[];
  };
  if (existing.rows.length > 0) return existing.rows[0].id;

  const name = env.ORG_NAME || "OpenBooks";
  const currency = env.ORG_CURRENCY?.trim().toUpperCase();
  const country = env.ORG_COUNTRY?.trim().toUpperCase();
  if (!currency) {
    throw new Error("ORG_CURRENCY is required when creating the first organization");
  }
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    throw new Error(
      "ORG_COUNTRY is required as an ISO 3166-1 alpha-2 code when creating the first organization",
    );
  }
  const ins = (await db.execute(sql`
    insert into orgs (name, base_currency, country) values (${name}, ${currency}, ${country})
    returning id
  `)) as unknown as { rows: { id: string }[] };
  const orgId = ins.rows[0].id;
  console.log(`[bootstrap] created org "${name}" (${currency}/${country})`);

  await db.execute(sql`
    insert into accounting_books (org_id, code, name, is_primary)
    values (${orgId}, 'primary', 'Primary book', true)
    on conflict do nothing
  `);

  const { calendarId } = await ensureCloseDefaults(orgId);

  // Monthly periods: two fiscal years back through five ahead — plenty for a
  // dev instance; Setup → Periods & Close manages them afterwards.
  const thisYear = new Date().getUTCFullYear();
  for (let y = thisYear - 2; y <= thisYear + 5; y++) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const endDate = new Date(Date.UTC(y, m, 0));
      const end = endDate.toISOString().slice(0, 10);
      await db.execute(sql`
        insert into accounting_periods (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on)
        values (${orgId}, ${calendarId}, ${y}, ${m}, ${`${y}-${String(m).padStart(2, "0")}`}, ${start}, ${end})
        on conflict do nothing
      `);
    }
  }
  console.log(
    `[bootstrap] primary book + periods ${thisYear - 2}..${thisYear + 5} ensured`,
  );
  return orgId;
}

async function seedCurrencies(): Promise<void> {
  for (const currency of SUPPORTED_CURRENCIES) {
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values (${currency.code}, ${currency.name}, ${currency.minorUnits})
      on conflict (code) do update
        set name = excluded.name, minor_units = excluded.minor_units
    `);
  }
  const configured = env.ORG_CURRENCY?.trim().toUpperCase();
  if (configured && !SUPPORTED_CURRENCIES.some((currency) => currency.code === configured)) {
    throw new Error(
      `ORG_CURRENCY ${configured} is not in OpenBooks' supported ISO 4217 registry`,
    );
  }
  console.log(`[bootstrap] ${SUPPORTED_CURRENCIES.length} currencies ensured`);
}

async function ensureRootSubsidiary(orgId: string): Promise<void> {
  await db.execute(sql`
    insert into subsidiaries
      (org_id, name, legal_name, base_currency, country, created_at, updated_at)
    select id, name, legal_name, base_currency, country, now(), now()
      from orgs
     where id = ${orgId}
       and not exists (
         select 1 from subsidiaries where org_id = ${orgId} and parent_id is null
       )
    on conflict do nothing
  `);
  const root = (await db.execute(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null
  `)) as unknown as { rows: { id: string }[] };
  if (root.rows.length !== 1) {
    throw new Error(`organization ${orgId} must have exactly one root subsidiary`);
  }
  console.log("[bootstrap] root subsidiary ensured");
}

async function seedRoles(orgId: string): Promise<void> {
  for (const [key, def] of Object.entries(BUILT_IN_ROLES)) {
    await db.execute(sql`
      insert into app_roles (org_id, key, name, description, is_built_in, permissions)
      values (${orgId}, ${key}, ${def.name}, ${def.description}, true, ${JSON.stringify(def.permissions)})
      on conflict (org_id, key) do update
        set name = excluded.name, description = excluded.description,
            is_built_in = true, permissions = excluded.permissions, updated_at = now()
    `);
  }
  console.log("[bootstrap] built-in roles ensured");
}

async function seedAdmin(orgId: string): Promise<void> {
  const email = env.ADMIN_EMAIL;
  if (!email) {
    console.log("[bootstrap] ADMIN_EMAIL not set — skipping admin seed");
    return;
  }
  const name = env.ADMIN_NAME || "Administrator";
  const password = env.ADMIN_PASSWORD || randomBytes(12).toString("base64url");
  const salt = randomBytes(16);
  const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
  // Only set the password when the user is first created — a running instance
  // must not have its admin password silently reset on every deploy.
  const created = await db.transaction(async (tx) => {
    const inserted = (await tx.execute(sql`
      insert into users (org_id, email, name, password_hash)
      values (${orgId}, ${email.toLowerCase()}, ${name}, ${hash})
      on conflict (org_id, email) do nothing
      returning id
    `)) as unknown as { rows: { id: string }[] };
    const userId = inserted.rows[0]?.id ?? ((await tx.execute(sql`
      select id from users where org_id = ${orgId} and email = ${email.toLowerCase()} limit 1
    `)) as unknown as { rows: { id: string }[] }).rows[0]?.id;
    if (!userId) throw new Error(`administrator ${email} could not be resolved after seed`);
    const assignment = (await tx.execute(sql`
      insert into role_assignments (org_id, user_id, role_id)
      select ${orgId}, ${userId}, id from app_roles
       where org_id = ${orgId} and key = 'admin'
      on conflict (org_id, user_id, role_id) do nothing
      returning id
    `)) as unknown as { rows: { id: string }[] };
    if (inserted.rows.length > 0 && assignment.rows.length === 0) {
      throw new Error("new administrator did not receive an explicit admin role assignment");
    }
    return inserted.rows.length > 0;
  });
  if (created) {
    console.log(
      `[bootstrap] admin user ${email} created${env.ADMIN_PASSWORD ? "" : ` — generated password: ${password}`}`,
    );
  } else {
    console.log(`[bootstrap] admin user ${email} already exists — untouched`);
  }
}

async function main(): Promise<void> {
  const runtimeConfig = runtimeDatabaseConfig();
  const constrainedSchemaOwnerMigration =
    env.OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION === "1";
  if (env.NODE_ENV === "production" && !runtimeConfig) {
    throw new Error(
      "OPENBOOKS_RUNTIME_DB_URL is required for production bootstrap; migrations and application traffic must use separate database roles",
    );
  }
  const lockClient = await pool.connect();
  let locked = false;
  try {
    // Rolling deployments can start more than one container against the same
    // database. Serialize the entire migrate+seed unit so one
    // bootstrap cannot seed a relation while another is changing its policy
    // or constraint definition.
    await lockClient.query("set statement_timeout = 0");
    await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      "openbooks:deployment-bootstrap",
    ]);
    locked = true;
    console.log("[bootstrap] starting");
    // Bootstrap is the one intentional installation-wide maintenance boundary.
    // Set it explicitly: an absent tenant remains fail-closed everywhere else,
    // while migration validation must see every row before it changes a global
    // constraint. Context-only scope keeps each tracked migration's own
    // transaction authoritative instead of pinning an outer transaction.
    await withBypassContext(async () => {
      if (constrainedSchemaOwnerMigration) {
        if (!runtimeConfig) {
          throw new Error(
            "constrained schema-owner migration requires OPENBOOKS_RUNTIME_DB_URL",
          );
        }
        await assertConstrainedSchemaOwnerMigrationRole(runtimeConfig);
        await migrate();
        return;
      }
      // Some migrations grant privileges to openbooks_read, so a fresh database
      // must establish the role before applying them. Run the same idempotent
      // routine again afterward to grant access to the newly created tables.
      await ensureReadRole();
      await migrate();
      if (runtimeConfig) await ensureRuntimeDatabaseRole(runtimeConfig);
      await ensureReadRole(runtimeConfig?.roleName);
      await seedCurrencies();
      const orgId = await ensureOrg();
      await ensureRootSubsidiary(orgId);
      await seedRoles(orgId);
      await seedProjectTypes(orgId);
      await seedAdmin(orgId);
      if (runtimeConfig) await verifyRuntimeDatabaseRole(runtimeConfig, orgId);
    });
    console.log("[bootstrap] done");
  } finally {
    if (locked) {
      await lockClient
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [
          "openbooks:deployment-bootstrap",
        ])
        .catch(() => {});
    }
    lockClient.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
