/** Historical payroll adjustment repairs must refuse cross-tenant and orphaned references. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const generated = join(dirname(fileURLToPath(import.meta.url)), "generated");
const cases = [
  { ordinal: "0208", file: "0208_pay_run_adjustments_run_tenant_coherence.sql", column: "pay_run_document_id", constraint: "pay_run_adjustments_run_fkey", table: "pay_runs", key: "document_id", tenantKey: "documentId", kind: "exclude" },
  { ordinal: "0218", file: "0218_pay_run_adjustments_component_tenant_coherence.sql", column: "component_id", constraint: "pay_run_adjustments_component_fkey", table: "pay_components", key: "id", tenantKey: "componentId", kind: "line" },
];

async function transaction(work) {
  const raw = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
  assert.ok(raw, "historical repair tests require the explicitly provisioned local test administrator");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(raw).hostname), "historical repair tests must never alter a remote database");
  const client = new pg.Client({ connectionString: raw });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls','on',true)");
    await work(client);
  } finally {
    try { await client.query("rollback"); } finally { await client.end(); }
  }
}

async function seedTenant(client, label) {
  const orgId = randomUUID();
  const subsidiaryId = randomUUID();
  const employeeId = randomUUID();
  const scheduleId = randomUUID();
  const documentId = randomUUID();
  const componentId = randomUUID();

  await client.query(
    `insert into currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     -- The baseline already seeds CAD; retaining its reviewed precision is intentional.
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `Adjustment tenant ${label}`],
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
  await client.query(
    `insert into pay_components (id, org_id, code, name, kind)
     values ($1, $2, $3, $4, 'earning')`,
    [componentId, orgId, `BONUS-${label}`, `Bonus ${label}`],
  );
  return { orgId, employeeId, documentId, componentId };
}


async function definition(client, subject) {
  const result = await client.query("select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.pay_run_adjustments'::regclass and conname=$1", [subject.constraint]);
  assert.equal(result.rows.length, 1, `${subject.constraint} must exist`);
  return result.rows[0].definition;
}

function repair(client, subject) {
  return client.query(readFileSync(join(generated, subject.file), "utf8"));
}

async function insert(client, subject, tenant, reference) {
  const id = randomUUID();
  await client.query(`insert into pay_run_adjustments
    (id,org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
    values ($1,$2,$3,$4,$5,$6,$7)`,
  [id, tenant.orgId, subject.column === "pay_run_document_id" ? reference : tenant.documentId,
    tenant.employeeId, subject.kind, subject.column === "component_id" ? reference : null,
    subject.kind === "line" ? "100.0000" : null]);
  return id;
}

async function row(client, id) {
  const result = await client.query("select * from pay_run_adjustments where id=$1", [id]);
  assert.equal(result.rows.length, 1, "the adjustment must remain observable");
  return result.rows[0];
}

async function refuses(client, operation, code, message) {
  await client.query("savepoint refused_write");
  await assert.rejects(operation(), (error) => {
    assert.equal(error.code, code);
    if (message) assert.ok(error.message.includes(message), error.message);
    return true;
  });
  await client.query("rollback to savepoint refused_write");
}

for (const subject of cases) {
  test(`${subject.column} accepts same-tenant references and refuses cross-tenant inserts and updates`, { skip: !DB }, () => transaction(async (client) => {
    await repair(client, subject);
    assert.equal(await definition(client, subject), `FOREIGN KEY (org_id, ${subject.column}) REFERENCES ${subject.table}(org_id, ${subject.key}) ON DELETE CASCADE DEFERRABLE`);
    const tenant = await seedTenant(client, "A");
    const other = await seedTenant(client, "B");
    const id = await insert(client, subject, tenant, tenant[subject.tenantKey]);
    const before = await row(client, id);
    assert.equal(before.org_id, tenant.orgId);
    assert.equal(before[subject.column], tenant[subject.tenantKey]);
    await refuses(client, () => insert(client, subject, tenant, other[subject.tenantKey]), "23503");
    await refuses(client, () => client.query(`update pay_run_adjustments set ${subject.column}=$1 where id=$2`, [other[subject.tenantKey], id]), "23503");
    assert.deepEqual(await row(client, id), before);
  }));

  test(`${subject.ordinal} refuses dirty cross-tenant and orphaned pointers without rewriting history`, { skip: !DB }, () => transaction(async (client) => {
    await repair(client, subject);
    const tenant = await seedTenant(client, "dirtyA");
    const other = await seedTenant(client, "dirtyB");
    await client.query(`alter table pay_run_adjustments drop constraint ${subject.constraint};
      alter table pay_run_adjustments add constraint ${subject.constraint}
      foreign key (${subject.column}) references ${subject.table} (${subject.key}) on delete cascade deferrable`);
    const legacy = await definition(client, subject);
    const cross = await insert(client, subject, tenant, other[subject.tenantKey]);
    const before = await row(client, cross);
    const message = `legacy data violates tenant coherence: public.pay_run_adjustments.${subject.column}`;
    await refuses(client, () => repair(client, subject), "23514", message);
    assert.deepEqual(await row(client, cross), before);
    assert.equal(await definition(client, subject), legacy);
    const deleted = await client.query("delete from pay_run_adjustments where id=$1", [cross]);
    assert.equal(deleted.rowCount, 1);
    await client.query(`alter table pay_run_adjustments drop constraint ${subject.constraint}`);
    const orphan = await insert(client, subject, tenant, randomUUID());
    const beforeOrphan = await row(client, orphan);
    await refuses(client, () => repair(client, subject), "23514", message);
    assert.deepEqual(await row(client, orphan), beforeOrphan);
  }));
}
