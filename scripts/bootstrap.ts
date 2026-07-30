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
import { db, env, pool } from "../engine/src/db.ts";
import { ensureCloseDefaults } from "../engine/src/close.ts";
import { seedProjectTypes } from "../engine/src/seed-project-types.ts";
import { BUILT_IN_ROLES } from "../web/lib/permissions.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "schema", "migrations");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Adopt two historical migrations that were applied manually before migration
 * tracking was introduced. Only mark them after every non-idempotent object is
 * present; a partial installation must still fail loudly and be repaired.
 */
async function adoptCompleteLegacyMigration(
  filename: string,
  content: string,
): Promise<void> {
  let complete = false;
  if (filename === "generated/0019_qbd_web_connector.sql") {
    const check = (await db.execute(sql`
      select
        to_regclass('public.qbd_captures') is not null
        and to_regclass('public.qbd_requests') is not null
        and to_regclass('public.qbd_sessions') is not null
        and (select count(*) from pg_indexes where schemaname = 'public' and indexname in (
          'qbd_captures_connection', 'qbd_captures_expiry', 'qbd_requests_next',
          'qbd_requests_capture', 'qbd_requests_capture_sequence',
          'qbd_sessions_connection', 'qbd_sessions_expiry'
        )) = 7
        and (select count(*) from pg_policies where schemaname = 'public'
             and tablename in ('qbd_captures', 'qbd_requests', 'qbd_sessions')
             and policyname = 'org_isolation') = 3 as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  } else if (filename === "generated/0024_file_source_identity.sql") {
    const check = (await db.execute(sql`
      select
        (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'files'
            and column_name in ('source_system', 'source_id')) = 2
        and to_regclass('public.files_source_identity') is not null as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  } else if (filename === "generated/0041_accounting_correctness.sql") {
    const check = (await db.execute(sql`
      select
        exists(select 1 from information_schema.columns where table_schema='public' and table_name='projects' and column_name='contract_value')
        and to_regclass('public.document_line_tax_components') is not null
        and exists(select 1 from information_schema.columns where table_schema='public' and table_name='tax_codes' and column_name='calculation_type')
        and exists(select 1 from pg_trigger where tgname='je_posted_balanced' and not tgisinternal)
        and (
          exists(select 1 from information_schema.columns where table_schema='public' and table_name='applications' and column_name='source_amount')
          or exists(select 1 from information_schema.columns where table_schema='public' and table_name='applications' and column_name='source_transaction_amount')
        ) as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  } else if (filename === "generated/0043_tax_pool_config.sql") {
    const check = (await db.execute(sql`
      select to_regclass('public.tax_regimes') is not null
        and to_regclass('public.tax_pool_classes') is not null
        and (select count(*) from pg_policies where schemaname='public' and tablename in ('tax_regimes','tax_pool_classes') and policyname='org_isolation')=2 as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  } else if (filename === "generated/0050_cross_currency_settlement.sql") {
    const check = (await db.execute(sql`
      select
        exists(select 1 from information_schema.columns where table_schema='public' and table_name='applications' and column_name='source_transaction_amount')
        and exists(select 1 from information_schema.columns where table_schema='public' and table_name='applications' and column_name='settlement_rate_reference')
        and not exists(select 1 from information_schema.columns where table_schema='public' and table_name='applications' and column_name='transaction_amount')
        and exists(select 1 from pg_trigger where tgname='app_validate_endpoints' and not tgisinternal) as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  } else if (filename === "generated/0052_asset_operating_controls.sql") {
    const check = (await db.execute(sql`
      select
        exists(select 1 from information_schema.columns where table_schema='public' and table_name='fixed_assets' and column_name='depreciation_method_id')
        and exists(select 1 from information_schema.columns where table_schema='public' and table_name='depreciation_inputs' and column_name='evidence_file_id')
        and not exists(select 1 from information_schema.columns where table_schema='public' and table_name='depreciation_inputs' and column_name='evidence_reference')
        and exists(select 1 from pg_trigger where tgname='depreciation_input_file_guard' and not tgisinternal) as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  } else if (filename === "generated/0053_report_delivery_outbox.sql") {
    const check = (await db.execute(sql`
      select to_regclass('public.report_run_artifacts') is not null
        and to_regclass('public.report_delivery_outbox') is not null
        and exists(select 1 from information_schema.columns where table_schema='public' and table_name='report_runs' and column_name='scheduled_for') as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  } else if (filename === "generated/0054_ownership_consolidation.sql") {
    const check = (await db.execute(sql`
      select to_regclass('public.subsidiary_ownership_interests') is not null
        and to_regclass('public.ownership_consolidation_runs') is not null
        and to_regclass('public.ownership_consolidation_entries') is not null
        and exists(select 1 from pg_trigger where tgname='ownership_interest_guard' and not tgisinternal) as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  } else if (filename === "generated/0055_negative_inventory_costing.sql") {
    const check = (await db.execute(sql`
      select to_regclass('public.inventory_provisional_costs') is not null
        and to_regclass('public.inventory_provisional_settlements') is not null
        and exists(select 1 from information_schema.columns where table_schema='public' and table_name='item_inventory_profiles' and column_name='allow_negative_inventory')
        and exists(select 1 from pg_trigger where tgname='inventory_provisional_settlement_immutable' and not tgisinternal) as complete
    `)) as unknown as { rows: { complete: boolean }[] };
    complete = check.rows[0]?.complete === true;
  }
  if (!complete) return;
  const inserted = (await db.execute(sql`
    insert into _applied_migrations (filename, sha256)
    values (${filename}, ${sha256(content)})
    on conflict do nothing
    returning filename
  `)) as unknown as { rows: { filename: string }[] };
  if (inserted.rows.length)
    console.log(`[bootstrap] adopted complete legacy migration: ${filename}`);
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

  // Baseline: a pre-existing database (the real cluster DB was built by
  // applying these files manually) has the schema but no tracking rows.
  // Record everything as applied instead of re-running CREATE TABLEs into it.
  const tracked = (await db.execute(
    sql`select count(*)::int as n from _applied_migrations`,
  )) as unknown as {
    rows: { n: number }[];
  };
  const hasSchema = (await db.execute(sql`
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'orgs'
  `)) as unknown as { rows: unknown[] };
  if (tracked.rows[0].n === 0 && hasSchema.rows.length > 0) {
    console.log(
      "[bootstrap] existing schema detected — baselining migration history without applying",
    );
    for (const f of generated) {
      const content = readFileSync(join(migrationsDir, "generated", f), "utf8");
      await db.execute(sql`
        insert into _applied_migrations (filename, sha256) values (${"generated/" + f}, ${sha256(content)})
        on conflict do nothing
      `);
    }
    for (const f of [
      "referential-integrity.sql",
      "referential-integrity-v2.sql",
      "referential-integrity-v3.sql",
      "kernel-constraints.sql",
    ]) {
      const content = readFileSync(join(migrationsDir, f), "utf8");
      await db.execute(sql`
        insert into _applied_migrations (filename, sha256) values (${f}, ${sha256(content)})
        on conflict do nothing
      `);
    }
  }
  for (const f of generated) {
    const filename = `generated/${f}`;
    const content = readFileSync(join(migrationsDir, "generated", f), "utf8");
    await adoptCompleteLegacyMigration(filename, content);
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

async function ensureReadRole(): Promise<void> {
  // Best-effort: on the shared cluster the role/grant already exist and the
  // app user may lack CREATEROLE/ADMIN OPTION — that's fine as long as
  // `set local role openbooks_read` works (verified below).
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
      "grant select",
      `grant select on all tables in schema public to openbooks_read`,
    ],
    [
      "default privileges",
      `alter default privileges in schema public grant select on tables to openbooks_read`,
    ],
    ["grant to app user", `grant openbooks_read to current_user`],
  ];
  for (const [label, stmt] of steps) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      console.warn(
        `[bootstrap] openbooks_read ${label} skipped: ${(err as Error).message}`,
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

  const name = env.ORG_NAME || "Openbooks Dev";
  const currency = env.ORG_CURRENCY || "CAD";
  const country = env.ORG_COUNTRY || "CA";
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
  const r = (await db.execute(sql`
    insert into users (org_id, email, name, password_hash, role)
    values (${orgId}, ${email.toLowerCase()}, ${name}, ${hash}, 'admin')
    on conflict (org_id, email) do nothing
    returning id
  `)) as unknown as { rows: { id: string }[] };
  if (r.rows.length > 0) {
    console.log(
      `[bootstrap] admin user ${email} created${env.ADMIN_PASSWORD ? "" : ` — generated password: ${password}`}`,
    );
  } else {
    console.log(`[bootstrap] admin user ${email} already exists — untouched`);
  }
}

async function main(): Promise<void> {
  const lockClient = await pool.connect();
  let locked = false;
  try {
    // Dokploy/rolling deployments can start more than one container against
    // the same database. Serialize the entire migrate+seed unit so one
    // bootstrap cannot seed a relation while another is changing its policy
    // or constraint definition.
    await lockClient.query("set statement_timeout = 0");
    await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      "openbooks:deployment-bootstrap",
    ]);
    locked = true;
    console.log("[bootstrap] starting");
    // Some migrations grant privileges to openbooks_read, so a fresh database
    // must establish the role before applying them. Run the same idempotent
    // routine again afterward to grant access to the newly created tables.
    await ensureReadRole();
    await migrate();
    await ensureReadRole();
    const orgId = await ensureOrg();
    await seedRoles(orgId);
    await seedProjectTypes(orgId);
    await seedAdmin(orgId);
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
