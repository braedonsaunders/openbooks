/**
 * Testdb proof for 0214_flow_gates_tenant_coherence.
 *
 * Same-org flow gates may name their flow and run. A cross-tenant flow_id
 * or run_id insert or update is refused by the composite FK. Applying 0214
 * against a dirty pointer (cross-tenant or orphaned) fails closed and does
 * not rewrite those rows. 0214 itself is not rewritten here.
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
  join(generatedDir, "0214_flow_gates_tenant_coherence.sql"),
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

async function constraintDefinition(client, name) {
  const result = await client.query(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conrelid = 'public.flow_gates'::regclass
        and conname = $1`,
    [name],
  );
  assert.equal(result.rows.length, 1, `${name} must exist`);
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
    [orgId, `Gate tenant ${label}`],
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

async function insertGate(client, gateId, orgId, flowId, runId, subjectId, nodeId = "gate-1") {
  await client.query(
    `insert into flow_gates (
       id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title, group_key
     ) values ($1, $2, $3, $4, $5, 'vendor_bill', $6, 'Approve', $7)`,
    [gateId, orgId, flowId, runId, nodeId, subjectId, `${runId}:${nodeId}`],
  );
}

async function restoreSingleColumnFks(client) {
  await client.query(`
    alter table public.flow_gates
      drop constraint if exists flow_gates_flow_id_fkey;
    alter table public.flow_gates
      drop constraint if exists flow_gates_run_id_fkey;
    alter table public.flow_gates
      add constraint flow_gates_flow_id_fkey
      foreign key (flow_id)
      references public.flows (id)
      on delete cascade
      deferrable;
    alter table public.flow_gates
      add constraint flow_gates_run_id_fkey
      foreign key (run_id)
      references public.flow_runs (id)
      on delete cascade
      deferrable;
  `);
}

test(
  "same-org flow gate can name its flow and run; cross-tenant insert and update are refused",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: adminConnectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      await applyRepair(client);
      assert.match(
        await constraintDefinition(client, "flow_gates_flow_id_fkey"),
        /FOREIGN KEY \(org_id, flow_id\) REFERENCES flows\(org_id, id\)/,
      );
      assert.match(
        await constraintDefinition(client, "flow_gates_run_id_fkey"),
        /FOREIGN KEY \(org_id, run_id\) REFERENCES flow_runs\(org_id, id\)/,
      );

      const orgA = await seedTenant(client, "A");
      const orgB = await seedTenant(client, "B");
      const sameOrgGate = randomUUID();
      await insertGate(
        client,
        sameOrgGate,
        orgA.orgId,
        orgA.flowId,
        orgA.runId,
        orgA.subjectId,
      );
      const stored = await client.query(
        `select org_id, flow_id, run_id from flow_gates where id = $1`,
        [sameOrgGate],
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].org_id, orgA.orgId);
      assert.equal(stored.rows[0].flow_id, orgA.flowId);
      assert.equal(stored.rows[0].run_id, orgA.runId);

      await client.query("savepoint before_cross_flow_insert");
      await assert.rejects(
        insertGate(
          client,
          randomUUID(),
          orgA.orgId,
          orgB.flowId,
          orgA.runId,
          orgA.subjectId,
          "gate-cross-flow",
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_flow_insert");

      await client.query("savepoint before_cross_run_insert");
      await assert.rejects(
        insertGate(
          client,
          randomUUID(),
          orgA.orgId,
          orgA.flowId,
          orgB.runId,
          orgA.subjectId,
          "gate-cross-run",
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_run_insert");

      await client.query("savepoint before_cross_flow_update");
      await assert.rejects(
        client.query(
          `update flow_gates set flow_id = $1 where id = $2`,
          [orgB.flowId, sameOrgGate],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_flow_update");

      await client.query("savepoint before_cross_run_update");
      await assert.rejects(
        client.query(
          `update flow_gates set run_id = $1 where id = $2`,
          [orgB.runId, sameOrgGate],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_run_update");

      const afterUpdate = await client.query(
        `select flow_id, run_id from flow_gates where id = $1`,
        [sameOrgGate],
      );
      assert.equal(afterUpdate.rows[0].flow_id, orgA.flowId);
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
  "0214 fails closed on a dirty cross-tenant or orphaned pointer and does not rewrite those rows",
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
      await restoreSingleColumnFks(client);
      assert.match(
        await constraintDefinition(client, "flow_gates_flow_id_fkey"),
        /FOREIGN KEY \(flow_id\) REFERENCES flows\(id\)/,
      );
      assert.match(
        await constraintDefinition(client, "flow_gates_run_id_fkey"),
        /FOREIGN KEY \(run_id\) REFERENCES flow_runs\(id\)/,
      );

      const crossTenantFlowGate = randomUUID();
      await insertGate(
        client,
        crossTenantFlowGate,
        orgA.orgId,
        orgB.flowId,
        orgA.runId,
        orgA.subjectId,
        "dirty-flow",
      );
      const beforeCrossFlow = await client.query(
        `select id, org_id::text, flow_id::text, run_id::text from flow_gates where id = $1`,
        [crossTenantFlowGate],
      );
      assert.equal(beforeCrossFlow.rows.length, 1);

      await client.query("savepoint before_cross_flow_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.flow_gates\.flow_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_flow_repair");
      const afterCrossFlow = await client.query(
        `select id, org_id::text, flow_id::text, run_id::text from flow_gates where id = $1`,
        [crossTenantFlowGate],
      );
      assert.deepEqual(afterCrossFlow.rows, beforeCrossFlow.rows);
      assert.match(
        await constraintDefinition(client, "flow_gates_flow_id_fkey"),
        /FOREIGN KEY \(flow_id\) REFERENCES flows\(id\)/,
      );

      await client.query(`delete from flow_gates where id = $1`, [crossTenantFlowGate]);

      const crossTenantRunGate = randomUUID();
      await insertGate(
        client,
        crossTenantRunGate,
        orgA.orgId,
        orgA.flowId,
        orgB.runId,
        orgA.subjectId,
        "dirty-run",
      );
      const beforeCrossRun = await client.query(
        `select id, org_id::text, flow_id::text, run_id::text from flow_gates where id = $1`,
        [crossTenantRunGate],
      );
      assert.equal(beforeCrossRun.rows.length, 1);

      await client.query("savepoint before_cross_run_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.flow_gates\.run_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_run_repair");
      const afterCrossRun = await client.query(
        `select id, org_id::text, flow_id::text, run_id::text from flow_gates where id = $1`,
        [crossTenantRunGate],
      );
      assert.deepEqual(afterCrossRun.rows, beforeCrossRun.rows);

      await client.query(`delete from flow_gates where id = $1`, [crossTenantRunGate]);
      await client.query(
        `alter table public.flow_gates drop constraint flow_gates_flow_id_fkey`,
      );
      const orphanedGate = randomUUID();
      await insertGate(
        client,
        orphanedGate,
        orgA.orgId,
        randomUUID(),
        orgA.runId,
        orgA.subjectId,
        "dirty-orphan",
      );
      const beforeOrphan = await client.query(
        `select id, org_id::text, flow_id::text, run_id::text from flow_gates where id = $1`,
        [orphanedGate],
      );
      assert.equal(beforeOrphan.rows.length, 1);

      await client.query("savepoint before_orphan_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.flow_gates\.flow_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_orphan_repair");
      const afterOrphan = await client.query(
        `select id, org_id::text, flow_id::text, run_id::text from flow_gates where id = $1`,
        [orphanedGate],
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
