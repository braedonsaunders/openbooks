/**
 * Testdb proof for 0215_flow_locks_tenant_coherence.
 *
 * Same-org flow locks may name their flow. A cross-tenant flow_id insert or
 * update is refused by the composite FK. Applying 0215 against a dirty
 * pointer (cross-tenant or orphaned) fails closed and does not rewrite
 * those rows. 0215 itself is not rewritten here.
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
  join(generatedDir, "0215_flow_locks_tenant_coherence.sql"),
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

async function constraintDefinition(client) {
  const result = await client.query(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conrelid = 'public.flow_locks'::regclass
        and conname = 'flow_locks_flow_id_fkey'`,
  );
  assert.equal(result.rows.length, 1, "flow_locks_flow_id_fkey must exist");
  return result.rows[0].definition;
}

async function applyRepair(client) {
  await client.query(repairSql);
}

async function seedTenant(client, label) {
  const orgId = randomUUID();
  const flowId = randomUUID();
  const subjectId = randomUUID();

  await client.query(
    `insert into currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `Lock tenant ${label}`],
  );
  await client.query(
    `insert into flows (id, org_id, name, subject_kind, graph)
     values ($1, $2, $3, 'vendor_bill', '{"nodes":[],"edges":[]}'::jsonb)`,
    [flowId, orgId, `Flow ${label}`],
  );
  return { orgId, flowId, subjectId };
}

async function insertLock(client, lockId, orgId, flowId, subjectId) {
  await client.query(
    `insert into flow_locks (id, org_id, subject_kind, subject_id, flow_id)
     values ($1, $2, 'vendor_bill', $3, $4)`,
    [lockId, orgId, subjectId, flowId],
  );
}

async function restoreSingleColumnFk(client) {
  await client.query(`
    alter table public.flow_locks
      drop constraint if exists flow_locks_flow_id_fkey;
    alter table public.flow_locks
      add constraint flow_locks_flow_id_fkey
      foreign key (flow_id)
      references public.flows (id)
      on delete cascade
      deferrable;
  `);
}

test(
  "same-org flow lock can name its flow; cross-tenant insert and update are refused",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: adminConnectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      await applyRepair(client);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(org_id, flow_id\) REFERENCES flows\(org_id, id\)/,
      );

      const orgA = await seedTenant(client, "A");
      const orgB = await seedTenant(client, "B");
      const sameOrgLock = randomUUID();
      await insertLock(client, sameOrgLock, orgA.orgId, orgA.flowId, orgA.subjectId);
      const stored = await client.query(
        `select org_id, flow_id from flow_locks where id = $1`,
        [sameOrgLock],
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].org_id, orgA.orgId);
      assert.equal(stored.rows[0].flow_id, orgA.flowId);

      await client.query("savepoint before_cross_insert");
      await assert.rejects(
        insertLock(client, randomUUID(), orgA.orgId, orgB.flowId, randomUUID()),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_insert");

      await client.query("savepoint before_cross_update");
      await assert.rejects(
        client.query(
          `update flow_locks set flow_id = $1 where id = $2`,
          [orgB.flowId, sameOrgLock],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_update");

      const afterUpdate = await client.query(
        `select flow_id from flow_locks where id = $1`,
        [sameOrgLock],
      );
      assert.equal(afterUpdate.rows[0].flow_id, orgA.flowId);
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
  "0215 fails closed on a dirty cross-tenant or orphaned pointer and does not rewrite those rows",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: adminConnectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      await applyRepair(client);

      const orgA = await seedTenant(client, "dirtyA");
      const orgB = await seedTenant(client, "dirtyB");
      await restoreSingleColumnFk(client);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(flow_id\) REFERENCES flows\(id\)/,
      );

      const crossTenantLock = randomUUID();
      await insertLock(client, crossTenantLock, orgA.orgId, orgB.flowId, orgA.subjectId);
      const beforeCross = await client.query(
        `select id, org_id::text, flow_id::text from flow_locks where id = $1`,
        [crossTenantLock],
      );
      assert.equal(beforeCross.rows.length, 1);

      await client.query("savepoint before_cross_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.flow_locks\.flow_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_repair");
      const afterCross = await client.query(
        `select id, org_id::text, flow_id::text from flow_locks where id = $1`,
        [crossTenantLock],
      );
      assert.deepEqual(afterCross.rows, beforeCross.rows);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(flow_id\) REFERENCES flows\(id\)/,
      );

      await client.query(`delete from flow_locks where id = $1`, [crossTenantLock]);
      await client.query(
        `alter table public.flow_locks drop constraint flow_locks_flow_id_fkey`,
      );
      const orphanedLock = randomUUID();
      await insertLock(client, orphanedLock, orgA.orgId, randomUUID(), orgA.subjectId);
      const beforeOrphan = await client.query(
        `select id, org_id::text, flow_id::text from flow_locks where id = $1`,
        [orphanedLock],
      );
      assert.equal(beforeOrphan.rows.length, 1);

      await client.query("savepoint before_orphan_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.flow_locks\.flow_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_orphan_repair");
      const afterOrphan = await client.query(
        `select id, org_id::text, flow_id::text from flow_locks where id = $1`,
        [orphanedLock],
      );
      assert.deepEqual(afterOrphan.rows, beforeOrphan.rows);
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  },
);
