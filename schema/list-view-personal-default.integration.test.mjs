/**
 * An owner has at most one live personal default list view per record type.
 *
 * The unique partial index admits defaults for other owners, organization
 * views, inactive views and non-default personal views, and refuses a second
 * live personal default for the same organization, owner and record type.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

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

async function seedTenant(client) {
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, 'List view tenant', 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId],
  );
  for (const [id, name] of [
    [ownerId, "Owner"],
    [otherOwnerId, "Other owner"],
  ]) {
    await client.query(
      `insert into users (id, org_id, email, name, password_hash, is_active)
       values ($1, $2, $3, $4, 'x', true)`,
      [id, orgId, `${id.slice(0, 8)}@list-view.test`, name],
    );
  }
  return { orgId, ownerId, otherOwnerId };
}

async function insertListView(client, { orgId, name, scope, ownerId, isDefault, isActive }) {
  const id = randomUUID();
  await client.query(
    `insert into list_views (
       id, org_id, record_type, name, scope, owner_id, is_default, is_active, config
     ) values ($1, $2, 'invoice', $3, $4, $5, $6, $7, '{}'::jsonb)`,
    [id, orgId, name, scope, ownerId, isDefault, isActive],
  );
  return id;
}

test(
  "a second live personal list-view default for the same owner and record type is refused",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: adminConnectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const index = await client.query(
        `select pg_get_indexdef(oid) as definition from pg_class
          where relname = 'list_views_one_live_personal_default' and relkind = 'i'`,
      );
      assert.equal(index.rows.length, 1, "list_views_one_live_personal_default must exist");
      assert.match(
        index.rows[0].definition,
        /^CREATE UNIQUE INDEX list_views_one_live_personal_default ON (?:public\.)?list_views USING btree \(org_id, owner_id, record_type\) WHERE \(\(scope = 'user'::text\) AND is_default AND is_active\)$/,
      );

      const tenant = await seedTenant(client);
      const firstId = await insertListView(client, {
        orgId: tenant.orgId,
        name: "My invoices",
        scope: "user",
        ownerId: tenant.ownerId,
        isDefault: true,
        isActive: true,
      });
      for (const admitted of [
        {
          name: "Other owner invoices",
          scope: "user",
          ownerId: tenant.otherOwnerId,
          isDefault: true,
          isActive: true,
        },
        { name: "Shared invoices", scope: "org", ownerId: null, isDefault: true, isActive: true },
        {
          name: "Inactive personal",
          scope: "user",
          ownerId: tenant.ownerId,
          isDefault: true,
          isActive: false,
        },
        {
          name: "Non-default personal",
          scope: "user",
          ownerId: tenant.ownerId,
          isDefault: false,
          isActive: true,
        },
      ]) {
        await insertListView(client, { orgId: tenant.orgId, ...admitted });
      }

      await client.query("savepoint before_second_live_default");
      await assert.rejects(
        insertListView(client, {
          orgId: tenant.orgId,
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
      assert.deepEqual(
        stored.rows.map((row) => row.id),
        [firstId],
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  },
);
