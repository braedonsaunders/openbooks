/**
 * Testdb proof for 0216_flow_run_effects_tenant_coherence.
 *
 * Same-org flow run effects may name their run. A cross-tenant run_id insert
 * or update is refused by the composite FK. Applying 0216 against a dirty
 * pointer (cross-tenant or orphaned) fails closed and does not rewrite
 * those rows. 0216 itself is not rewritten here.
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
  join(generatedDir, "0216_flow_run_effects_tenant_coherence.sql"),
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
      where conrelid = 'public.flow_run_effects'::regclass
        and conname = 'flow_run_effects_run_id_fkey'`,
  );
  assert.equal(result.rows.length, 1, "flow_run_effects_run_id_fkey must exist");
  return result.rows[0].definition;
}

async function applyRepair(client) {
  await client.query(repairSql);
}

async function seedTenant(client, label) {
  const orgId = randomUUID();
  const flowId = randomUUID();
  const runId = randomUUID();
  const subjectId = randomUUID();

  await client.query(
    `insert into currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `Effect tenant ${label}`],
  );
  await client.query(
    `insert into flows (id, org_id, name, subject_kind, graph)
     values ($1, $2, $3, 'vendor_bill', '{"nodes":[],"edges":[]}'::jsonb)`,
    [flowId, orgId, `Flow ${label}`],
  );
  await client.query(
    `insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger)
     values ($1, $2, $3, 'vendor_bill', $4, 'manual')`,
    [runId, orgId, flowId, subjectId],
  );
  return { orgId, flowId, runId, subjectId };
}

async function insertEffect(client, effectId, orgId, runId, effectKey) {
  await client.query(
    `insert into flow_run_effects (id, org_id, run_id, effect_key)
     values ($1, $2, $3, $4)`,
    [effectId, orgId, runId, effectKey],
  );
}

async function restoreSingleColumnFk(client) {
  await client.query(`
    alter table public.flow_run_effects
      drop constraint if exists flow_run_effects_run_id_fkey;
    alter table public.flow_run_effects
      add constraint flow_run_effects_run_id_fkey
      foreign key (run_id)
      references public.flow_runs (id)
      on delete cascade
      deferrable;
  `);
}

test(
  "same-org flow run effect can name its run; cross-tenant insert and update are refused",
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
        /FOREIGN KEY \(org_id, run_id\) REFERENCES flow_runs\(org_id, id\)/,
      );

      const orgA = await seedTenant(client, "A");
      const orgB = await seedTenant(client, "B");
      const sameOrgEffect = randomUUID();
      await insertEffect(client, sameOrgEffect, orgA.orgId, orgA.runId, "same-org");
      const stored = await client.query(
        `select org_id, run_id from flow_run_effects where id = $1`,
        [sameOrgEffect],
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].org_id, orgA.orgId);
      assert.equal(stored.rows[0].run_id, orgA.runId);

      await client.query("savepoint before_cross_insert");
      await assert.rejects(
        insertEffect(client, randomUUID(), orgA.orgId, orgB.runId, "cross-insert"),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_insert");

      await client.query("savepoint before_cross_update");
      await assert.rejects(
        client.query(
          `update flow_run_effects set run_id = $1 where id = $2`,
          [orgB.runId, sameOrgEffect],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_update");

      const afterUpdate = await client.query(
        `select run_id from flow_run_effects where id = $1`,
        [sameOrgEffect],
      );
      assert.equal(afterUpdate.rows[0].run_id, orgA.runId);
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
  "0216 fails closed on a dirty cross-tenant or orphaned pointer and does not rewrite those rows",
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
        /FOREIGN KEY \(run_id\) REFERENCES flow_runs\(id\)/,
      );

      const crossTenantEffect = randomUUID();
      await insertEffect(
        client,
        crossTenantEffect,
        orgA.orgId,
        orgB.runId,
        "dirty-cross",
      );
      const beforeCross = await client.query(
        `select id, org_id::text, run_id::text from flow_run_effects where id = $1`,
        [crossTenantEffect],
      );
      assert.equal(beforeCross.rows.length, 1);

      await client.query("savepoint before_cross_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.flow_run_effects\.run_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_repair");
      const afterCross = await client.query(
        `select id, org_id::text, run_id::text from flow_run_effects where id = $1`,
        [crossTenantEffect],
      );
      assert.deepEqual(afterCross.rows, beforeCross.rows);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(run_id\) REFERENCES flow_runs\(id\)/,
      );

      await client.query(`delete from flow_run_effects where id = $1`, [crossTenantEffect]);
      await client.query(
        `alter table public.flow_run_effects drop constraint flow_run_effects_run_id_fkey`,
      );
      const orphanedEffect = randomUUID();
      await insertEffect(
        client,
        orphanedEffect,
        orgA.orgId,
        randomUUID(),
        "dirty-orphan",
      );
      const beforeOrphan = await client.query(
        `select id, org_id::text, run_id::text from flow_run_effects where id = $1`,
        [orphanedEffect],
      );
      assert.equal(beforeOrphan.rows.length, 1);

      await client.query("savepoint before_orphan_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.flow_run_effects\.run_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_orphan_repair");
      const afterOrphan = await client.query(
        `select id, org_id::text, run_id::text from flow_run_effects where id = $1`,
        [orphanedEffect],
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
