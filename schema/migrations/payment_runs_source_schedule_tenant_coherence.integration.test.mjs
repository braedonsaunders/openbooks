/**
 * Testdb proof for 0210_payment_runs_source_schedule_tenant_coherence.
 *
 * Same-org payment runs may name their source schedule. A cross-tenant
 * source_schedule_id insert or update is refused by the composite FK.
 * Applying 0210 against a dirty pointer (cross-tenant or orphaned) fails
 * closed and does not rewrite those rows. 0210 itself is not rewritten here.
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
  join(generatedDir, "0210_payment_runs_source_schedule_tenant_coherence.sql"),
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
      where conrelid = 'public.payment_runs'::regclass
        and conname = 'payment_runs_source_schedule_id_fkey'`,
  );
  assert.equal(result.rows.length, 1, "payment_runs_source_schedule_id_fkey must exist");
  return result.rows[0].definition;
}

async function applyRepair(client) {
  await client.query(repairSql);
}

async function seedTenant(client, label) {
  const orgId = randomUUID();
  const accountId = randomUUID();
  const formatId = randomUUID();
  const profileId = randomUUID();
  const scheduleId = randomUUID();

  await client.query(
    `insert into currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `Payment-run tenant ${label}`],
  );
  await client.query(
    `insert into accounts (id, org_id, name, type, reconcilable, currency_restriction)
     values ($1, $2, $3, 'asset_bank', true, 'CAD')`,
    [accountId, orgId, `Bank ${label}`],
  );
  await client.query(
    `insert into payment_formats (id, org_id, code, name, rail, direction)
     values ($1, $2, $3, $4, 'cpa005_credit', 'credit')`,
    [formatId, orgId, `fmt-${label}`, `Format ${label}`],
  );
  await client.query(
    `insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency)
     values ($1, $2, $3, $4, $5, 'CAD')`,
    [profileId, orgId, `Profile ${label}`, accountId, formatId],
  );
  await client.query(
    `insert into payment_schedules (id, org_id, name, payment_bank_profile_id, cron, timezone)
     values ($1, $2, $3, $4, '0 8 * * 1', 'UTC')`,
    [scheduleId, orgId, `Schedule ${label}`, profileId],
  );
  return { orgId, accountId, scheduleId };
}

async function insertRun(client, runId, orgId, accountId, sourceScheduleId, runNumber) {
  await client.query(
    `insert into payment_runs (id, org_id, run_number, bank_account_id, method, source_schedule_id)
     values ($1, $2, $3, $4, 'eft', $5)`,
    [runId, orgId, runNumber, accountId, sourceScheduleId],
  );
}

test(
  "same-org payment run can name its source schedule; cross-tenant insert and update are refused",
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
        /FOREIGN KEY \(org_id, source_schedule_id\) REFERENCES payment_schedules\(org_id, id\)/,
      );

      const orgA = await seedTenant(client, "A");
      const orgB = await seedTenant(client, "B");
      const sameOrgRun = randomUUID();
      await insertRun(client, sameOrgRun, orgA.orgId, orgA.accountId, orgA.scheduleId, "RUN-A");
      const stored = await client.query(
        `select org_id, source_schedule_id from payment_runs where id = $1`,
        [sameOrgRun],
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].org_id, orgA.orgId);
      assert.equal(stored.rows[0].source_schedule_id, orgA.scheduleId);

      await client.query("savepoint before_cross_insert");
      await assert.rejects(
        insertRun(client, randomUUID(), orgA.orgId, orgA.accountId, orgB.scheduleId, "RUN-X"),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_insert");

      await client.query("savepoint before_cross_update");
      await assert.rejects(
        client.query(
          `update payment_runs set source_schedule_id = $1 where id = $2`,
          [orgB.scheduleId, sameOrgRun],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_update");

      const afterUpdate = await client.query(
        `select source_schedule_id from payment_runs where id = $1`,
        [sameOrgRun],
      );
      assert.equal(afterUpdate.rows[0].source_schedule_id, orgA.scheduleId);
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
  "0210 fails closed on a dirty cross-tenant or orphaned pointer and does not rewrite those rows",
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
      await client.query(`
        alter table public.payment_runs
          drop constraint payment_runs_source_schedule_id_fkey;
        alter table public.payment_runs
          add constraint payment_runs_source_schedule_id_fkey
          foreign key (source_schedule_id)
          references public.payment_schedules (id)
          deferrable;
      `);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(source_schedule_id\) REFERENCES payment_schedules\(id\)/,
      );

      const crossTenantRun = randomUUID();
      await insertRun(
        client,
        crossTenantRun,
        orgA.orgId,
        orgA.accountId,
        orgB.scheduleId,
        "RUN-DIRTY",
      );
      const beforeCross = await client.query(
        `select id, org_id::text, source_schedule_id::text from payment_runs where id = $1`,
        [crossTenantRun],
      );
      assert.equal(beforeCross.rows.length, 1);

      await client.query("savepoint before_cross_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          const text = String(error);
          assert.match(text, /23514|legacy data violates tenant coherence/);
          assert.match(
            text,
            /legacy data violates tenant coherence: public\.payment_runs\.source_schedule_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_repair");
      const afterCross = await client.query(
        `select id, org_id::text, source_schedule_id::text from payment_runs where id = $1`,
        [crossTenantRun],
      );
      assert.deepEqual(afterCross.rows, beforeCross.rows);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(source_schedule_id\) REFERENCES payment_schedules\(id\)/,
      );

      await client.query(
        `alter table public.payment_runs drop constraint payment_runs_source_schedule_id_fkey`,
      );
      const orphanedRun = randomUUID();
      await insertRun(client, orphanedRun, orgA.orgId, orgA.accountId, randomUUID(), "RUN-ORPHAN");
      const beforeOrphan = await client.query(
        `select id, org_id::text, source_schedule_id::text from payment_runs where id = $1`,
        [orphanedRun],
      );
      assert.equal(beforeOrphan.rows.length, 1);

      await client.query("savepoint before_orphan_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          const text = String(error);
          assert.match(text, /23514|legacy data violates tenant coherence/);
          assert.match(
            text,
            /legacy data violates tenant coherence: public\.payment_runs\.source_schedule_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_orphan_repair");
      const afterOrphan = await client.query(
        `select id, org_id::text, source_schedule_id::text from payment_runs where id = $1`,
        [orphanedRun],
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
