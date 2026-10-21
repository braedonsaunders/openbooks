// source-pin-contract: published migration bytes — 0064 is replayed from its digest-verified published body, and every later published migration is swept for explicit rebuilds of the governed document_lines view against a reviewed list
/// <reference types="node" />

/** The published quantity change is replayed in isolated historical catalogs.
 * Native bootstrap separately proves the current supported baseline. No migration
 * ledger entries are fabricated to make an unsupported catalog appear current.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { executeOrderQuantityProgressMigration } from "../scripts/bootstrap/governed-views.ts";

const execFileAsync = promisify(execFile);
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

// These suites replay migrations inside a throwaway database they provision
// themselves: CREATE DATABASE and CREATE ROLE are bootstrap-superuser work, not
// runtime-role work. CI connects every other step as the constrained owner
// (openbooks_app) on purpose, so that role deliberately lacks CREATEDB and the
// provisioning here fails with 42501. Take the admin URL CI supplies.
const ADMIN_DB_URL = (): string => {
  // Refuse by name rather than fall back to the runtime login: the constrained
  // role cannot replay migrations, and the fallback did not fail, it hung with
  // no database activity. scripts/testdb.sh print_env and .github/workflows/
  // test.yml both emit the privileged URL.
  const url = process.env.OPENBOOKS_TEST_ADMIN_DB_URL?.trim();
  assert.ok(
    url,
    "this test replays migrations with the privileged test-cluster login and requires " +
      "OPENBOOKS_TEST_ADMIN_DB_URL (emitted by scripts/testdb.sh env and .github/workflows/test.yml); " +
      "refusing rather than falling back to the runtime role",
  );
  return url;
};

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
        // The bypass pool prefers the admin login over the scratch URL, so
        // blank it and the other diverting logins too.
        OPENBOOKS_TEST_OWNERSHIP_TRANSFER: "",
        OPENBOOKS_TEST_ADMIN_DB_URL: "",
        OPENBOOKS_BYPASS_DB_URL: "",
        OPENBOOKS_MIGRATION_DB_URL: "",
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

async function readViewMetadata(client: Pick<pg.PoolClient,"query">): Promise<ViewMetadata> {
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
  client: pg.PoolClient;
  pool: pg.Pool;
}> {
  const name = `openbooks_qty_upgrade_${suffix}_${randomBytes(3).toString("hex")}`;
  const controlUrl = new URL(baseUrl.href);
  controlUrl.pathname = "/postgres";
  const control = new pg.Client({ connectionString: controlUrl.href });
  await control.connect();
  await control.query(`create database "${name}"`);
  const databaseUrl = new URL(baseUrl.href);
  databaseUrl.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: databaseUrl.href, max:1 });
  const client = await pool.connect();
  return { name, url: databaseUrl.href, control, client, pool };
}

async function dropScratchDatabase(scratch: Awaited<ReturnType<typeof createScratchDatabase>>): Promise<void> {
  scratch.client.release();
  await scratch.pool.end();
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

test("no later migration silently rebuilds the governed document_lines view",
  { timeout: 60_000 },
  async () => {
    assert.deepEqual(
      explicitDocumentLinesViewRebuilds(postMigrationFiles),
      REVIEWED_DOCUMENT_LINES_VIEW_REBUILDS,
      "a new explicit rebuild of openbooks_query.document_lines needs review here",
    );
  },
);

test("published quantity migration preserves its view contract and matches native baseline precision",
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

      // Exercise the published repair directly in this isolated catalog. The
      // application bootstrap only accepts its supported native baseline.
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

      await executeOrderQuantityProgressMigration(isolated.client,migrationBody,createHash("sha256").update(migrationBody).digest("hex"));
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

      // No second schema-only run here: with provisioning skipped it repeats
      // Preserve existing four-decimal values while the published change widens them.
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

      await executeOrderQuantityProgressMigration(upgrade.client,migrationBody,createHash("sha256").update(migrationBody).digest("hex"));

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

      // Reapplying the published SQL preserves the repaired catalog and data.
      await executeOrderQuantityProgressMigration(upgrade.client,migrationBody,createHash("sha256").update(migrationBody).digest("hex"));
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
