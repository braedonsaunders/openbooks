/**
 * Testdb proof for 0219_list_views_one_live_personal_default.
 *
 * A second live personal isDefault for the same owner and record type
 * is refused by the unique partial index. Applying 0219 against dirty
 * duplicate live defaults fails closed and does not rewrite those rows.
 * 0219 itself is not rewritten here.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const generatedDir = join(dirname(fileURLToPath(import.meta.url)), "generated");
const repairSql = readFileSync(
  join(generatedDir, "0219_list_views_one_live_personal_default.sql"),
  "utf8",
);

function adminConnectionString() {
  const explicit = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
  if (explicit) return explicit.trim();
  const runtime = process.env.OPENBOOKS_DB_URL;
  if (!runtime) return "";
  const url = new URL(runtime);
  url.username = "openbooks";
  url.password = process.env.PGPASSWORD || "openbooks";
  return url.href;
}

function postgresCode(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current.code) return current.code;
    current = current.cause;
  }
  return undefined;
}

async function indexDefinition(client) {
  const result = await client.query(
    `select pg_get_indexdef(oid) as definition
       from pg_class
      where relname = 'list_views_one_live_personal_default'
        and relkind = 'i'`,
  );
  assert.equal(result.rows.length, 1, "list_views_one_live_personal_default must exist");
  return result.rows[0].definition;
}

async function applyRepair(client) {
  await client.query(repairSql);
}

async function seedTenant(client, label) {
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();

  await client.query(
    `insert into currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `List view tenant ${label}`],
  );
  await client.query(
    `insert into users (id, org_id, email, name, password_hash, is_active)
     values ($1, $2, $3, $4, 'x', true)`,
    [ownerId, orgId, `owner-${ownerId.slice(0, 8)}@list-view.test`, `Owner ${label}`],
  );
  await client.query(
    `insert into users (id, org_id, email, name, password_hash, is_active)
     values ($1, $2, $3, $4, 'x', true)`,
    [otherOwnerId, orgId, `other-${otherOwnerId.slice(0, 8)}@list-view.test`, `Other ${label}`],
  );
  return { orgId, ownerId, otherOwnerId };
}

async function insertListView(client, {
  id,
  orgId,
  recordType,
  name,
  scope,
  ownerId,
  isDefault,
  isActive,
}) {
  await client.query(
    `insert into list_views (
       id, org_id, record_type, name, scope, owner_id, is_default, is_active, config
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)`,
    [id, orgId, recordType, name, scope, ownerId, isDefault, isActive],
  );
}

test(
  "a second live personal list-view isDefault is refused",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: adminConnectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      await applyRepair(client);
      const definition = await indexDefinition(client);
      assert.equal(
        definition.includes("CREATE UNIQUE INDEX list_views_one_live_personal_default"),
        true,
      );
      assert.equal(definition.includes("org_id, owner_id, record_type"), true);
      assert.equal(definition.includes("scope = 'user'"), true);

      const tenant = await seedTenant(client, "unique");
      const firstId = randomUUID();
      await insertListView(client, {
        id: firstId,
        orgId: tenant.orgId,
        recordType: "invoice",
        name: "My invoices",
        scope: "user",
        ownerId: tenant.ownerId,
        isDefault: true,
        isActive: true,
      });
      await insertListView(client, {
        id: randomUUID(),
        orgId: tenant.orgId,
        recordType: "invoice",
        name: "Other owner invoices",
        scope: "user",
        ownerId: tenant.otherOwnerId,
        isDefault: true,
        isActive: true,
      });
      await insertListView(client, {
        id: randomUUID(),
        orgId: tenant.orgId,
        recordType: "invoice",
        name: "Shared invoices",
        scope: "org",
        ownerId: null,
        isDefault: true,
        isActive: true,
      });
      await insertListView(client, {
        id: randomUUID(),
        orgId: tenant.orgId,
        recordType: "invoice",
        name: "Inactive personal",
        scope: "user",
        ownerId: tenant.ownerId,
        isDefault: true,
        isActive: false,
      });
      await insertListView(client, {
        id: randomUUID(),
        orgId: tenant.orgId,
        recordType: "invoice",
        name: "Non-default personal",
        scope: "user",
        ownerId: tenant.ownerId,
        isDefault: false,
        isActive: true,
      });

      await client.query("savepoint before_second_live_default");
      await assert.rejects(
        insertListView(client, {
          id: randomUUID(),
          orgId: tenant.orgId,
          recordType: "invoice",
          name: "Second default",
          scope: "user",
          ownerId: tenant.ownerId,
          isDefault: true,
          isActive: true,
        }),
        (error) => {
          assert.equal(postgresCode(error), "23505");
          return true;
        },
      );
      await client.query("rollback to savepoint before_second_live_default");

      const stored = await client.query(
        `select id from list_views
          where org_id = $1 and owner_id = $2 and record_type = 'invoice'
            and scope = 'user' and is_default and is_active`,
        [tenant.orgId, tenant.ownerId],
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].id, firstId);
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  },
);

test(
  "0219 fails closed on dirty live personal defaults and does not rewrite those rows",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: adminConnectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      await applyRepair(client);
      await client.query("drop index if exists public.list_views_one_live_personal_default");

      const tenant = await seedTenant(client, "dirty");
      const firstId = randomUUID();
      const secondId = randomUUID();
      await insertListView(client, {
        id: firstId,
        orgId: tenant.orgId,
        recordType: "bill",
        name: "Dirty first",
        scope: "user",
        ownerId: tenant.ownerId,
        isDefault: true,
        isActive: true,
      });
      await insertListView(client, {
        id: secondId,
        orgId: tenant.orgId,
        recordType: "bill",
        name: "Dirty second",
        scope: "user",
        ownerId: tenant.ownerId,
        isDefault: true,
        isActive: true,
      });
      const before = await client.query(
        `select id, org_id::text, owner_id::text, record_type, is_default, is_active
           from list_views
          where id = any($1::uuid[])
          order by name`,
        [[firstId, secondId]],
      );
      assert.equal(before.rows.length, 2);

      await client.query("savepoint before_dirty_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          return true;
        },
      );
      await client.query("rollback to savepoint before_dirty_repair");

      const after = await client.query(
        `select id, org_id::text, owner_id::text, record_type, is_default, is_active
           from list_views
          where id = any($1::uuid[])
          order by name`,
        [[firstId, secondId]],
      );
      assert.deepEqual(after.rows, before.rows);
      const missing = await client.query(
        `select 1
           from pg_class
          where relname = 'list_views_one_live_personal_default'
            and relkind = 'i'`,
      );
      assert.equal(missing.rows.length, 0);
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  },
);
