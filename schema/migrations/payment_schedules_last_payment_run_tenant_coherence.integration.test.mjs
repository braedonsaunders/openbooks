/**
 * Testdb proof for 0212_payment_schedules_last_payment_run_tenant_coherence.
 *
 * Same-org payment schedules may name their last payment run. A cross-tenant
 * last_payment_run_id insert or update is refused by the composite FK.
 * Applying 0212 against a dirty pointer (cross-tenant or orphaned) fails
 * closed and does not rewrite those rows. 0212 itself is not rewritten here.
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
  join(generatedDir, "0212_payment_schedules_last_payment_run_tenant_coherence.sql"),
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
      where conrelid = 'public.payment_schedules'::regclass
        and conname = 'payment_schedules_last_payment_run_id_fkey'`,
  );
  assert.equal(result.rows.length, 1, "payment_schedules_last_payment_run_id_fkey must exist");
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
  const runId = randomUUID();

  await client.query(
    `insert into currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `Schedule tenant ${label}`],
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
  await client.query(
    `insert into payment_runs (id, org_id, run_number, bank_account_id, method)
     values ($1, $2, $3, $4, 'eft')`,
    [runId, orgId, `RUN-${label}`, accountId],
  );
  return { orgId, accountId, profileId, scheduleId, runId };
}

async function insertSchedule(client, scheduleId, orgId, name, profileId, lastPaymentRunId) {
  await client.query(
    `insert into payment_schedules (id, org_id, name, payment_bank_profile_id, cron, timezone, last_payment_run_id)
     values ($1, $2, $3, $4, '0 8 * * 1', 'UTC', $5)`,
    [scheduleId, orgId, name, profileId, lastPaymentRunId],
  );
}

test(
  "same-org payment schedule can name its last run; cross-tenant insert and update are refused",
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
        /FOREIGN KEY \(org_id, last_payment_run_id\) REFERENCES payment_runs\(org_id, id\)/,
      );

      const orgA = await seedTenant(client, "A");
      const orgB = await seedTenant(client, "B");
      const sameOrgSchedule = randomUUID();
      await insertSchedule(
        client,
        sameOrgSchedule,
        orgA.orgId,
        "Schedule same-org last run",
        orgA.profileId,
        orgA.runId,
      );
      const stored = await client.query(
        `select org_id, last_payment_run_id from payment_schedules where id = $1`,
        [sameOrgSchedule],
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].org_id, orgA.orgId);
      assert.equal(stored.rows[0].last_payment_run_id, orgA.runId);

      await client.query("savepoint before_cross_insert");
      await assert.rejects(
        insertSchedule(
          client,
          randomUUID(),
          orgA.orgId,
          "Schedule cross-tenant last run",
          orgA.profileId,
          orgB.runId,
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_insert");

      await client.query("savepoint before_cross_update");
      await assert.rejects(
        client.query(
          `update payment_schedules set last_payment_run_id = $1 where id = $2`,
          [orgB.runId, sameOrgSchedule],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_update");

      const afterUpdate = await client.query(
        `select last_payment_run_id from payment_schedules where id = $1`,
        [sameOrgSchedule],
      );
      assert.equal(afterUpdate.rows[0].last_payment_run_id, orgA.runId);
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
  "0212 fails closed on a dirty cross-tenant or orphaned pointer and does not rewrite those rows",
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
        alter table public.payment_schedules
          drop constraint payment_schedules_last_payment_run_id_fkey;
        alter table public.payment_schedules
          add constraint payment_schedules_last_payment_run_id_fkey
          foreign key (last_payment_run_id)
          references public.payment_runs (id)
          deferrable;
      `);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(last_payment_run_id\) REFERENCES payment_runs\(id\)/,
      );

      const crossTenantSchedule = randomUUID();
      await insertSchedule(
        client,
        crossTenantSchedule,
        orgA.orgId,
        "Schedule dirty last run",
        orgA.profileId,
        orgB.runId,
      );
      const beforeCross = await client.query(
        `select id, org_id::text, last_payment_run_id::text from payment_schedules where id = $1`,
        [crossTenantSchedule],
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
            /legacy data violates tenant coherence: public\.payment_schedules\.last_payment_run_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_repair");
      const afterCross = await client.query(
        `select id, org_id::text, last_payment_run_id::text from payment_schedules where id = $1`,
        [crossTenantSchedule],
      );
      assert.deepEqual(afterCross.rows, beforeCross.rows);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(last_payment_run_id\) REFERENCES payment_runs\(id\)/,
      );

      await client.query(
        `alter table public.payment_schedules drop constraint payment_schedules_last_payment_run_id_fkey`,
      );
      const orphanedSchedule = randomUUID();
      await insertSchedule(
        client,
        orphanedSchedule,
        orgA.orgId,
        "Schedule orphan last run",
        orgA.profileId,
        randomUUID(),
      );
      const beforeOrphan = await client.query(
        `select id, org_id::text, last_payment_run_id::text from payment_schedules where id = $1`,
        [orphanedSchedule],
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
            /legacy data violates tenant coherence: public\.payment_schedules\.last_payment_run_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_orphan_repair");
      const afterOrphan = await client.query(
        `select id, org_id::text, last_payment_run_id::text from payment_schedules where id = $1`,
        [orphanedSchedule],
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
