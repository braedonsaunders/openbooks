/**
 * Deployment bootstrap — idempotent, runs before the web server starts.
 *
 *   1. Applies schema/migrations/generated/*.sql in filename order, tracked in
 *      _applied_migrations (skip-once semantics; a changed already-applied file
 *      logs a loud warning instead of re-running).
 *   2. Applies referential-integrity.sql + kernel-constraints.sql the same way.
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
import { BUILT_IN_ROLES } from "../web/lib/permissions.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "schema", "migrations");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function applyTracked(label: string, filename: string, content: string): Promise<void> {
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
    throw new Error(`[bootstrap] ${filename} failed: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

async function migrate(): Promise<void> {
  // The id() column default across the whole schema — a plain SQL v7-UUID
  // generator (no extension). Must exist before the first CREATE TABLE.
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
     RETURNS uuid
     LANGUAGE sql
     PARALLEL SAFE
    AS $fn$
      select encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
        placing substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
        from 1 for 6), 52, 1), 53, 1), 'hex')::uuid
    $fn$;
  `));
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
  const tracked = (await db.execute(sql`select count(*)::int as n from _applied_migrations`)) as unknown as {
    rows: { n: number }[];
  };
  const hasSchema = (await db.execute(sql`
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'orgs'
  `)) as unknown as { rows: unknown[] };
  if (tracked.rows[0].n === 0 && hasSchema.rows.length > 0) {
    console.log("[bootstrap] existing schema detected — baselining migration history without applying");
    for (const f of generated) {
      const content = readFileSync(join(migrationsDir, "generated", f), "utf8");
      await db.execute(sql`
        insert into _applied_migrations (filename, sha256) values (${"generated/" + f}, ${sha256(content)})
        on conflict do nothing
      `);
    }
    for (const f of ["referential-integrity.sql", "kernel-constraints.sql"]) {
      const content = readFileSync(join(migrationsDir, f), "utf8");
      await db.execute(sql`
        insert into _applied_migrations (filename, sha256) values (${f}, ${sha256(content)})
        on conflict do nothing
      `);
    }
  }
  for (const f of generated) {
    await applyTracked("migration", `generated/${f}`, readFileSync(join(migrationsDir, "generated", f), "utf8"));
  }
  for (const f of ["referential-integrity.sql", "kernel-constraints.sql"]) {
    await applyTracked("constraints", f, readFileSync(join(migrationsDir, f), "utf8"));
  }
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
    ["grant select", `grant select on all tables in schema public to openbooks_read`],
    ["default privileges", `alter default privileges in schema public grant select on tables to openbooks_read`],
    ["grant to app user", `grant openbooks_read to current_user`],
  ];
  for (const [label, stmt] of steps) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      console.warn(`[bootstrap] openbooks_read ${label} skipped: ${(err as Error).message}`);
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
    console.warn("[bootstrap] WARNING: cannot assume openbooks_read — SQL workbench/user-script queries will fail");
  }
}

async function ensureOrg(): Promise<string> {
  const existing = (await db.execute(sql`select id from orgs order by created_at limit 1`)) as unknown as {
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

  // Monthly periods: two fiscal years back through five ahead — plenty for a
  // dev instance; the period-close UI manages them afterwards.
  const thisYear = new Date().getUTCFullYear();
  for (let y = thisYear - 2; y <= thisYear + 5; y++) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const endDate = new Date(Date.UTC(y, m, 0));
      const end = endDate.toISOString().slice(0, 10);
      await db.execute(sql`
        insert into accounting_periods (org_id, fiscal_year, period_number, name, starts_on, ends_on)
        values (${orgId}, ${y}, ${m}, ${`${y}-${String(m).padStart(2, "0")}`}, ${start}, ${end})
        on conflict do nothing
      `);
    }
  }
  console.log(`[bootstrap] primary book + periods ${thisYear - 2}..${thisYear + 5} ensured`);
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
  console.log("[bootstrap] starting");
  await migrate();
  await ensureReadRole();
  const orgId = await ensureOrg();
  await seedRoles(orgId);
  await seedAdmin(orgId);
  console.log("[bootstrap] done");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
