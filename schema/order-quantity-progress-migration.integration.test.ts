/// <reference types="node" />

/**
 * Live-PostgreSQL proof for the 0064 upgrade boundary. PostgreSQL refuses to
 * alter a table column while the governed query view depends on it, so this
 * suite builds the genuine pre-0064 catalog, runs the real bootstrap, and
 * checks both the schema values and the view contract that bootstrap repairs.
 *
 * Structural note: production bootstrap ALWAYS migrates fully before it
 * provisions org defaults, so provisioning only ever sees the current schema.
 * Faking the post-0064 ledger and then running a FULL bootstrap creates a
 * state production never produces (frozen schema + current engine) and breaks
 * for any future migration that adds a column provisioning writes. The suite
 * therefore splits the proof: an isolated schema-only scratch exercises
 * 0064's repair with the tail faked (via the existing production
 * OPENBOOKS_RESTORE_TARGET schema-only mode, no orgs, no provisioning), while
 * a data-upgrade scratch with real rows runs the FULL tail plus provisioning
 * with no faked ledger. A static guard allowlists the one reviewed explicit
 * view rebuild after 0064 (0161) so a silent rebuild forces a test update.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";

const execFileAsync = promisify(execFile);
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

// These suites replay migrations inside a throwaway database they provision
// themselves: CREATE DATABASE and CREATE ROLE are bootstrap-superuser work, not
// runtime-role work. CI connects every other step as the constrained owner
// (openbooks_app) on purpose, so that role deliberately lacks CREATEDB and the
// provisioning here fails with 42501. Take the admin URL when CI supplies one
// and fall back to the ordinary URL locally, where they are the same superuser.
const ADMIN_DB_URL = () =>
  (process.env.OPENBOOKS_TEST_ADMIN_DB_URL || process.env.OPENBOOKS_DB_URL)!.trim();

const root = join(import.meta.dirname, "..");
const generatedDir = join(root, "schema", "migrations", "generated");
const migrationName = "0064_order_quantity_progress_precision.sql";
const migrationPath = join(generatedDir, migrationName);
const migrationBody = readFileSync(migrationPath, "utf8");
assert.equal(
  createHash("sha256").update(migrationBody).digest("hex"),
  "1c92eb07479a3bf9eb93ab14841df51d1d05dcbb5c95b4b492578f2f90f85b34",
);
const publishedFiles = readdirSync(generatedDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrationIndex = publishedFiles.indexOf(migrationName);
assert.ok(migrationIndex > 0, "0064 must be a published forward migration");
const preMigrationFiles = publishedFiles
  .slice(0, migrationIndex)
  .map((name) => ({ name, body: readFileSync(join(generatedDir, name), "utf8") }));
const postMigrationFiles = publishedFiles
  .slice(migrationIndex + 1)
  .map((name) => ({ name, body: readFileSync(join(generatedDir, name), "utf8") }));

// Reviewed explicit rebuilds of the governed document_lines view after 0064.
// 0161 widens the view with the allocation distribution stamps; any NEW entry
// here must be a reviewed migration, and any new explicit rebuild without an
// allowlist update fails this suite by construction.
const REVIEWED_DOCUMENT_LINES_VIEW_REBUILDS = [
  "0161_allocation_query_catalog.sql",
];

function explicitDocumentLinesViewRebuilds(
  files: Array<{ name: string; body: string }>,
): string[] {
  return files
    .filter(
      (file) =>
        file.body.includes("CREATE VIEW openbooks_query.document_lines")
        || /DROP VIEW[^;]*openbooks_query\.document_lines/.test(file.body),
    )
    .map((file) => file.name);
}

type ViewMetadata = {
  owner: string;
  acl: string[] | null;
  options: string[] | null;
  objectComment: string | null;
  columnComments: Array<{ name: string; comment: string | null }>;
};

async function runBootstrap(
  databaseUrl: string,
  options?: { restoreTarget?: boolean },
): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/bootstrap.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        OPENBOOKS_DB_URL: databaseUrl,
        OPENBOOKS_RUNTIME_DB_URL: "",
        OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION: "",
        // This suite bootstraps a throwaway database of its own, so the CI
        // harness flags that shape the SHARED test database must not leak in.
        // Ownership transfer refuses without OPENBOOKS_RUNTIME_DB_URL, which
        // is deliberately blank here, so inheriting it fails the bootstrap.
        OPENBOOKS_TEST_OWNERSHIP_TRANSFER: "",
        // The isolated scratch uses the existing production schema-only mode:
        // migrate + currencies, no org, no provisioning. That is the honest
        // way to exercise 0064's repair without provisioning against a frozen
        // schema production never produces. NOT a test backdoor flag.
        OPENBOOKS_RESTORE_TARGET: options?.restoreTarget ? "1" : "",
        ORG_CURRENCY: "USD",
        ORG_COUNTRY: "US",
        OPENBOOKS_DATA_KEY:
          process.env.OPENBOOKS_DATA_KEY
          ?? "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}

async function readViewMetadata(client: pg.Client): Promise<ViewMetadata> {
  const relation = await client.query<{
    owner: string;
    acl: string[] | null;
    options: string[] | null;
    objectComment: string | null;
    oid: string;
  }>(`select pg_get_userbyid(relation.relowner) as owner,
             relation.relacl as acl,
             relation.reloptions as options,
             obj_description(relation.oid, 'pg_class') as "objectComment",
             relation.oid::text
        from pg_class relation
        join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
       where namespace_row.nspname = 'openbooks_query'
         and relation.relname = 'document_lines'`);
  assert.equal(relation.rows.length, 1);
  const row = relation.rows[0]!;
  const columns = await client.query<{ name: string; comment: string | null }>(
    `select attribute.attname as name,
            col_description(attribute.attrelid, attribute.attnum) as comment
       from pg_attribute attribute
      where attribute.attrelid = $1::oid
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by attribute.attnum`,
    [row.oid],
  );
  return {
    owner: row.owner,
    // pg_class.relacl is an array whose ORDER reflects the sequence grants
    // happened in, which PostgreSQL does not promise to preserve across a
    // rewrite. What must survive the repair is the SET of grants, so compare
    // it as one: an order-sensitive compare fails on a database whose roles
    // were granted in a different order and proves nothing either way.
    acl: row.acl === null ? null : [...row.acl].sort(),
    options: row.options,
    objectComment: row.objectComment,
    columnComments: columns.rows,
  };
}

async function createScratchDatabase(baseUrl: URL, suffix: string): Promise<{
  name: string;
  url: string;
  control: pg.Client;
  client: pg.Client;
}> {
  const name = `openbooks_qty_upgrade_${suffix}_${randomBytes(3).toString("hex")}`;
  const controlUrl = new URL(baseUrl.href);
  controlUrl.pathname = "/postgres";
  const control = new pg.Client({ connectionString: controlUrl.href });
  await control.connect();
  await control.query(`create database "${name}"`);
  const databaseUrl = new URL(baseUrl.href);
  databaseUrl.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: databaseUrl.href });
  await client.connect();
  return { name, url: databaseUrl.href, control, client };
}

async function dropScratchDatabase(scratch: Awaited<ReturnType<typeof createScratchDatabase>>): Promise<void> {
  await scratch.client.end().catch(() => undefined);
  await scratch.control
    .query(`drop database if exists "${scratch.name}" with (force)`)
    .catch(() => undefined);
  await scratch.control.end().catch(() => undefined);
}

async function ensureReplayRoles(control: pg.Client): Promise<void> {
  // Bootstrap establishes these roles before a migration can mention them.
  await control.query(`do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'openbooks_read') then
          create role openbooks_read nologin;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'openbooks_app') then
          create role openbooks_app nologin;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'quantity_view_reader') then
          create role quantity_view_reader nologin;
        end if;
      end $$;`);
}

test(
  "no later migration silently rebuilds the governed document_lines view",
  { timeout: 60_000 },
  async () => {
    assert.deepEqual(
      explicitDocumentLinesViewRebuilds(postMigrationFiles),
      REVIEWED_DOCUMENT_LINES_VIEW_REBUILDS,
      "a new explicit rebuild of openbooks_query.document_lines needs review here",
    );
  },
);

test(
  "0064 upgrades and replays without losing the governed view contract",
  { skip: !DB, timeout: 300_000 },
  async () => {
    const baseUrl = new URL(ADMIN_DB_URL());
    const isolated = await createScratchDatabase(baseUrl, "isolated");
    const upgrade = await createScratchDatabase(baseUrl, "upgrade");
    const fresh = await createScratchDatabase(baseUrl, "fresh");
    try {
      for (const scratch of [isolated, upgrade]) {
        await ensureReplayRoles(scratch.control);
        await scratch.client.query("select set_config('app.bypass_rls', 'on', false)");
        for (const file of preMigrationFiles) {
          await scratch.client.query(file.body);
        }
      }

      // Isolated repair proof: schema-only scratch with the tail faked so ONLY
      // 0064 runs. Zero orgs + OPENBOOKS_RESTORE_TARGET keeps bootstrap on its
      // production migrate-only path (no provisioning), which is the only
      // honest way to hold the schema at 0064: production never provisions
      // against a frozen schema. The separate data-upgrade scratch below runs
      // the real tail with provisioning.
      await isolated.client.query(`
        create table public._applied_migrations (
          filename text primary key,
          sha256 text not null,
          applied_at timestamptz not null default now()
        )`);
      // Keep the isolated scratch focused on 0064. Later migrations are marked
      // at their published digests so they cannot rebuild this view after the
      // repair (the data-upgrade and empty-database runs below exercise the
      // full tail for real, and the static guard above pins the allowlisted
      // explicit rebuilds).
      for (const file of [...preMigrationFiles, ...postMigrationFiles]) {
        const digest = createHash("sha256")
          .update(file.body)
          .digest("hex");
        await isolated.client.query(
          `insert into public._applied_migrations (filename, sha256) values ($1, $2)`,
          [`generated/${file.name}`, digest],
        );
      }

      await isolated.client.query(
        "comment on view openbooks_query.document_lines is 'quantity-view-contract'",
      );
      await isolated.client.query(
        "comment on column openbooks_query.document_lines.quantity_fulfilled is 'fulfilled-contract'",
      );
      await isolated.client.query(
        "comment on column openbooks_query.document_lines.quantity_billed is 'billed-contract'",
      );
      await isolated.client.query(
        "grant select on table openbooks_query.document_lines to quantity_view_reader",
      );
      const before = await readViewMetadata(isolated.client);

      await runBootstrap(isolated.url, { restoreTarget: true });
      const after = await readViewMetadata(isolated.client);
      assert.deepEqual(after, before, "owner, ACL, options, and comments survive the repair");

      const isolatedType = await isolated.client.query<{ precision: number; scale: number }>(
        `select numeric_precision as precision, numeric_scale as scale
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'document_lines'
            and column_name = 'quantity_fulfilled'`,
      );
      assert.deepEqual(isolatedType.rows[0], { precision: 28, scale: 8 });
      const isolatedView = await isolated.client.query<{ predicate: string }>(
        `select pg_get_viewdef('openbooks_query.document_lines'::regclass, true) as predicate`,
      );
      assert.match(isolatedView.rows[0]!.predicate, /openbooks_query_org_id\(\)/);

      // A second schema-only bootstrap sees the exact ledger digest and must
      // leave the repaired catalog untouched rather than dropping the view again.
      await runBootstrap(isolated.url, { restoreTarget: true });
      assert.deepEqual(await readViewMetadata(isolated.client), before);
      const isolatedRetry = await isolated.client.query<{ precision: number; scale: number }>(
        `select numeric_precision as precision, numeric_scale as scale
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'document_lines'
            and column_name = 'quantity_fulfilled'`,
      );
      assert.deepEqual(isolatedRetry.rows[0], { precision: 28, scale: 8 });

      // Data-upgrade proof: real rows through the REAL tail. Only the pre-0064
      // ledger is seeded, so bootstrap applies 0064 plus every later migration
      // and then provisions org defaults against the current schema — exactly
      // the production order. Nothing is faked, so future provisioning columns
      // cannot break this path.
      await upgrade.client.query(`
        create table public._applied_migrations (
          filename text primary key,
          sha256 text not null,
          applied_at timestamptz not null default now()
        )`);
      for (const file of preMigrationFiles) {
        const digest = createHash("sha256")
          .update(file.body)
          .digest("hex");
        await upgrade.client.query(
          `insert into public._applied_migrations (filename, sha256) values ($1, $2)`,
          [`generated/${file.name}`, digest],
        );
      }

      const orgA = randomUUID();
      const orgB = randomUUID();
      const accountA = randomUUID();
      const accountB = randomUUID();
      const documentA = randomUUID();
      const documentB = randomUUID();
      const lineA = randomUUID();
      const lineB = randomUUID();
      await upgrade.client.query(
        `insert into currencies (code, name, minor_units)
         values ('USD', 'US Dollar', 2)
         on conflict (code) do nothing`,
      );
      await upgrade.client.query(
        `insert into orgs (id, name, base_currency, country) values
         ($1, 'Quantity A', 'USD', 'US'), ($2, 'Quantity B', 'USD', 'US')`,
        [orgA, orgB],
      );
      await upgrade.client.query(
        `insert into accounts (id, org_id, name, type) values
         ($1, $3, 'Quantity A account', 'asset_current'),
         ($2, $4, 'Quantity B account', 'asset_current')`,
        [accountA, accountB, orgA, orgB],
      );
      await upgrade.client.query(
        `insert into documents (id, org_id, kind, document_number, document_date, currency)
         values ($1, $3, 'sales_order', 'QTY-A', '2026-08-01', 'USD'),
                ($2, $4, 'sales_order', 'QTY-B', '2026-08-01', 'USD')`,
        [documentA, documentB, orgA, orgB],
      );
      // These are valid four-decimal values in the genuine pre-0064 state.
      await upgrade.client.query(
        `insert into document_lines
           (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount,
            quantity_fulfilled, quantity_billed)
         values ($1, $3, $5, 1, $7, '2.00000001', '10', '20', '0.1234', '0.0001'),
                ($2, $4, $6, 1, $8, '3.00000001', '10', '30', '0.0000', '0.0000')`,
        [lineA, lineB, orgA, orgB, documentA, documentB, accountA, accountB],
      );

      await runBootstrap(upgrade.url);

      const progress = await upgrade.client.query<{
        fulfilledPrecision: number;
        fulfilledScale: number;
        billedPrecision: number;
        billedScale: number;
        fulfilledDefault: string | null;
        billedDefault: string | null;
        fulfilled: string;
        billed: string;
      }>(`select fulfilled.numeric_precision as "fulfilledPrecision",
                 fulfilled.numeric_scale as "fulfilledScale",
                 billed.numeric_precision as "billedPrecision",
                 billed.numeric_scale as "billedScale",
                 fulfilled.column_default as "fulfilledDefault",
                 billed.column_default as "billedDefault",
                 lines.quantity_fulfilled::text as fulfilled,
                 lines.quantity_billed::text as billed
            from information_schema.columns fulfilled
            join information_schema.columns billed
              on billed.table_schema = fulfilled.table_schema
             and billed.table_name = fulfilled.table_name
             and billed.column_name = 'quantity_billed'
            join public.document_lines lines on lines.id = $1
           where fulfilled.table_schema = 'public'
             and fulfilled.table_name = 'document_lines'
             and fulfilled.column_name = 'quantity_fulfilled'`,
        [lineA],
      );
      const shape = progress.rows[0]!;
      assert.deepEqual(
        {
          fulfilledPrecision: shape.fulfilledPrecision,
          fulfilledScale: shape.fulfilledScale,
          billedPrecision: shape.billedPrecision,
          billedScale: shape.billedScale,
        },
        { fulfilledPrecision: 28, fulfilledScale: 8, billedPrecision: 28, billedScale: 8 },
      );
      assert.match(shape.fulfilledDefault ?? "", /0/);
      assert.match(shape.billedDefault ?? "", /0/);
      assert.equal(shape.fulfilled, "0.12340000");
      assert.equal(shape.billed, "0.00010000");

      // Provisioning ran against the current schema (production order), so the
      // current engine defaults exist for the upgraded org. A frozen schema
      // would have failed before reaching this read.
      const crmDefaults = await upgrade.client.query<{ count: string }>(
        `select count(*)::text as count from public.crm_opportunity_statuses where org_id = $1`,
        [orgA],
      );
      assert.equal(crmDefaults.rows[0]!.count, "6");

      const highPrecisionLine = randomUUID();
      await upgrade.client.query(
        `insert into document_lines
           (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount,
            quantity_fulfilled, quantity_billed)
         values ($1, $2, $3, 2, $4, '1.00000001', '10', '10', '1.23456789', '0.00000001')`,
        [highPrecisionLine, orgA, documentA, accountA],
      );
      await upgrade.client.query(
        "create temporary table if not exists openbooks_query_context (org_id uuid)",
      );
      await upgrade.client.query("truncate table pg_temp.openbooks_query_context");
      await upgrade.client.query(
        "insert into pg_temp.openbooks_query_context (org_id) values ($1)",
        [orgA],
      );
      const tenantRows = await upgrade.client.query<{ id: string; fulfilled: string }>(
        `select id, quantity_fulfilled::text as fulfilled
           from openbooks_query.document_lines
          order by id`,
      );
      assert.deepEqual(
        tenantRows.rows,
        [
          { id: highPrecisionLine, fulfilled: "1.23456789" },
          { id: lineA, fulfilled: "0.12340000" },
        ].sort((left, right) => left.id.localeCompare(right.id)),
        "the recreated view keeps its exact tenant predicate and precision",
      );

      // A second real bootstrap sees the exact ledger digest and must leave the
      // repaired catalog untouched rather than dropping the view again.
      await runBootstrap(upgrade.url);
      const retryType = await upgrade.client.query<{ precision: number; scale: number }>(
        `select numeric_precision as precision, numeric_scale as scale
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'document_lines'
            and column_name = 'quantity_fulfilled'`,
      );
      assert.deepEqual(retryType.rows[0], { precision: 28, scale: 8 });
      const retryView = await upgrade.client.query<{ predicate: string }>(
        `select pg_get_viewdef('openbooks_query.document_lines'::regclass, true) as predicate`,
      );
      assert.match(retryView.rows[0]!.predicate, /openbooks_query_org_id\(\)/);

      // The same published chain must also work on a genuinely empty database.
      await runBootstrap(fresh.url);
      const freshType = await fresh.client.query<{ precision: number; scale: number }>(
        `select numeric_precision as precision, numeric_scale as scale
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'document_lines'
            and column_name = 'quantity_billed'`,
      );
      assert.deepEqual(freshType.rows[0], { precision: 28, scale: 8 });
      const freshView = await fresh.client.query<{ predicate: string }>(
        `select pg_get_viewdef('openbooks_query.document_lines'::regclass, true) as predicate`,
      );
      assert.match(freshView.rows[0]!.predicate, /openbooks_query_org_id\(\)/);
    } finally {
      await dropScratchDatabase(isolated);
      await dropScratchDatabase(upgrade);
      await dropScratchDatabase(fresh);
    }
  },
);
