/**
 * Testdb proof for 0217_pay_run_holiday_assertions_run_tenant_coherence.
 *
 * Same-org holiday assertions may name their pay run. A cross-tenant
 * pay_run_document_id insert or update is refused by the composite FK.
 * Applying 0217 against a dirty pointer (cross-tenant or orphaned) fails
 * closed and does not rewrite those rows. 0217 itself is not rewritten here.
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
  join(generatedDir, "0217_pay_run_holiday_assertions_run_tenant_coherence.sql"),
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
      where conrelid = 'public.pay_run_holiday_assertions'::regclass
        and conname = 'pay_run_holiday_assertions_run_fkey'`,
  );
  assert.equal(result.rows.length, 1, "pay_run_holiday_assertions_run_fkey must exist");
  return result.rows[0].definition;
}

async function applyRepair(client) {
  await client.query(repairSql);
}

async function seedTenant(client, label) {
  const orgId = randomUUID();
  const subsidiaryId = randomUUID();
  const employeeId = randomUUID();
  const scheduleId = randomUUID();
  const documentId = randomUUID();

  await client.query(
    `insert into currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `Holiday assertion tenant ${label}`],
  );
  await client.query(
    `insert into subsidiaries (id, org_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
     values ($1, $2, $3, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`,
    [subsidiaryId, orgId, `Main ${label}`],
  );
  await client.query(
    `insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
     values ($1, $2, 'person', $3, true, $4, '{}'::jsonb)`,
    [employeeId, orgId, `Employee ${label}`, subsidiaryId],
  );
  await client.query(
    `insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active)
     values ($1, $2, $3, 'biweekly', 26, '2026-07-18', 3, true)`,
    [scheduleId, orgId, `Biweekly ${label}`],
  );
  await client.query(
    `insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status)
     values ($1, $2, 'pay_run', $3, $4, '2026-07-21', 'CAD', 'draft')`,
    [orgId, documentId, `PAY-${label}-${documentId.slice(0, 8)}`, subsidiaryId],
  );
  await client.query(
    `insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status)
     values ($1, $2, $3, '2026-07-05', '2026-07-18', '2026-07-21', 2026, 'draft')`,
    [documentId, orgId, scheduleId],
  );
  return { orgId, employeeId, documentId };
}

async function insertAssertion(client, assertionId, orgId, payRunDocumentId, employeeId, holidayKey) {
  await client.query(
    `insert into pay_run_holiday_assertions (
       id, org_id, pay_run_document_id, employee_party_id, holiday_key, holiday_date,
       absent_without_consent
     ) values ($1, $2, $3, $4, $5, '2026-07-01', false)`,
    [assertionId, orgId, payRunDocumentId, employeeId, holidayKey],
  );
}

async function restoreSingleColumnFk(client) {
  await client.query(`
    alter table public.pay_run_holiday_assertions
      drop constraint if exists pay_run_holiday_assertions_run_fkey;
    alter table public.pay_run_holiday_assertions
      add constraint pay_run_holiday_assertions_run_fkey
      foreign key (pay_run_document_id)
      references public.pay_runs (document_id)
      on delete cascade
      deferrable;
  `);
}

test(
  "same-org holiday assertion can name its pay run; cross-tenant insert and update are refused",
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
        /FOREIGN KEY \(org_id, pay_run_document_id\) REFERENCES pay_runs\(org_id, document_id\)/,
      );

      const orgA = await seedTenant(client, "A");
      const orgB = await seedTenant(client, "B");
      const sameOrgAssertion = randomUUID();
      await insertAssertion(
        client,
        sameOrgAssertion,
        orgA.orgId,
        orgA.documentId,
        orgA.employeeId,
        "same-org",
      );
      const stored = await client.query(
        `select org_id, pay_run_document_id from pay_run_holiday_assertions where id = $1`,
        [sameOrgAssertion],
      );
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0].org_id, orgA.orgId);
      assert.equal(stored.rows[0].pay_run_document_id, orgA.documentId);

      await client.query("savepoint before_cross_insert");
      await assert.rejects(
        insertAssertion(
          client,
          randomUUID(),
          orgA.orgId,
          orgB.documentId,
          orgA.employeeId,
          "cross-insert",
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
          `update pay_run_holiday_assertions set pay_run_document_id = $1 where id = $2`,
          [orgB.documentId, sameOrgAssertion],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_update");

      const afterUpdate = await client.query(
        `select pay_run_document_id from pay_run_holiday_assertions where id = $1`,
        [sameOrgAssertion],
      );
      assert.equal(afterUpdate.rows[0].pay_run_document_id, orgA.documentId);
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
  "0217 fails closed on a dirty cross-tenant or orphaned pointer and does not rewrite those rows",
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
        /FOREIGN KEY \(pay_run_document_id\) REFERENCES pay_runs\(document_id\)/,
      );

      const crossTenantAssertion = randomUUID();
      await insertAssertion(
        client,
        crossTenantAssertion,
        orgA.orgId,
        orgB.documentId,
        orgA.employeeId,
        "dirty-cross",
      );
      const beforeCross = await client.query(
        `select id, org_id::text, pay_run_document_id::text from pay_run_holiday_assertions where id = $1`,
        [crossTenantAssertion],
      );
      assert.equal(beforeCross.rows.length, 1);

      await client.query("savepoint before_cross_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.pay_run_holiday_assertions\.pay_run_document_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_cross_repair");
      const afterCross = await client.query(
        `select id, org_id::text, pay_run_document_id::text from pay_run_holiday_assertions where id = $1`,
        [crossTenantAssertion],
      );
      assert.deepEqual(afterCross.rows, beforeCross.rows);
      assert.match(
        await constraintDefinition(client),
        /FOREIGN KEY \(pay_run_document_id\) REFERENCES pay_runs\(document_id\)/,
      );

      await client.query(`delete from pay_run_holiday_assertions where id = $1`, [
        crossTenantAssertion,
      ]);
      await client.query(
        `alter table public.pay_run_holiday_assertions drop constraint pay_run_holiday_assertions_run_fkey`,
      );
      const orphanedAssertion = randomUUID();
      await insertAssertion(
        client,
        orphanedAssertion,
        orgA.orgId,
        randomUUID(),
        orgA.employeeId,
        "dirty-orphan",
      );
      const beforeOrphan = await client.query(
        `select id, org_id::text, pay_run_document_id::text from pay_run_holiday_assertions where id = $1`,
        [orphanedAssertion],
      );
      assert.equal(beforeOrphan.rows.length, 1);

      await client.query("savepoint before_orphan_repair");
      await assert.rejects(
        applyRepair(client),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          assert.match(
            String(error),
            /legacy data violates tenant coherence: public\.pay_run_holiday_assertions\.pay_run_document_id/,
          );
          return true;
        },
      );
      await client.query("rollback to savepoint before_orphan_repair");
      const afterOrphan = await client.query(
        `select id, org_id::text, pay_run_document_id::text from pay_run_holiday_assertions where id = $1`,
        [orphanedAssertion],
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
