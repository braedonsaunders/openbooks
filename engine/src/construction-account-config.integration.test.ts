import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";
import { approvePayApplication, ConstructionBillingError, createPayApplication, generatePayApplicationInvoice, submitPayApplication } from "./construction-billing.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Fixture = { org: Awaited<ReturnType<typeof createScratchOrg>>; actor: string; approver: string; sov: string; idleSov: string; app: string };

async function fixture(run: (f: Fixture) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Construction account controller", "admin");
    const approver = await createScratchUser(org.orgId, "Construction account approver", "admin");
    const project = randomUUID(), type = randomUUID(), sov = randomUUID(), idleSov = randomUUID();
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true}'::jsonb) where id=${org.orgId}`);
    const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${type},${org.orgId},'construction_accounts_test','Construction accounts test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch construction account policy')`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'CCA','Construction account job',${org.customerId},${type},'active')`);
    await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,sort_order,income_account_id)
      values(${sov},${org.orgId},${project},'Configured work','4000',1,${org.accounts.revenue}),
      (${idleSov},${org.orgId},${project},'Unbilled work','1000',2,null)`);
    const app = (await withOrgTransaction(org.orgId, () => createPayApplication(org.orgId, actor, project, org.date, "0"))).id;
    await withOrgTransaction(org.orgId, () => submitPayApplication(org.orgId, actor, app, [{ sovLineId: sov, thisPeriodCompleted: "1000.1234", materialsStored: "0" }]));
    await withOrgTransaction(org.orgId, () => approvePayApplication(org.orgId, approver, app));
    await run({ org, actor, approver, sov, idleSov, app });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

async function snapshot(f: Fixture) {
  return (await db.execute(sql`
    select
      (select to_jsonb(a) from pay_applications a where a.org_id=${f.org.orgId} and a.id=${f.app}) as application,
      (select jsonb_agg(to_jsonb(l) order by l.id) from pay_application_lines l where l.org_id=${f.org.orgId} and l.pay_application_id=${f.app}) as source_lines,
      (select jsonb_agg(to_jsonb(l) order by l.id) from sov_lines l where l.org_id=${f.org.orgId}) as sov,
      (select jsonb_agg(to_jsonb(d) order by d.id) from documents d where d.org_id=${f.org.orgId}) as documents,
      (select jsonb_agg(to_jsonb(l) order by l.id) from document_lines l where l.org_id=${f.org.orgId}) as invoice_lines,
      (select jsonb_agg(to_jsonb(n) order by n.id) from number_sequences n where n.org_id=${f.org.orgId}) as numbers,
      (select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where a.org_id=${f.org.orgId}) as audit
  `)).rows[0];
}

async function refusedWithoutWrites(f: Fixture, message: RegExp) {
  const before = await snapshot(f);
  await assert.rejects(withOrgTransaction(f.org.orgId, () => generatePayApplicationInvoice(f.org.orgId, f.actor, f.app)),
    (error: unknown) => error instanceof ConstructionBillingError && message.test(error.message));
  assert.deepEqual(await snapshot(f), before, "refusal preserves source, invoice, numbering, and audit evidence exactly");
}

async function generatedWithAccount(f: Fixture, accountId: string) {
  const generated = await withOrgTransaction(f.org.orgId, () => generatePayApplicationInvoice(f.org.orgId, f.actor, f.app));
  const lines = (await db.execute(sql`select account_id, amount::text, unit_price::text from document_lines where org_id=${f.org.orgId} and document_id=${generated.invoiceId} order by line_number`)).rows;
  assert.deepEqual(lines, [{ account_id: accountId, amount: "1000.1234", unit_price: "1000.12340000" }]);
  assert.equal(generated.currentDue, "1000.1234");
  assert.deepEqual((await db.execute(sql`select status, invoice_document_id from pay_applications where org_id=${f.org.orgId} and id=${f.app}`)).rows[0],
    { status: "invoiced", invoice_document_id: generated.invoiceId });
}

test("construction invoice refuses missing SOV account despite chart revenues without writes", enabled, async () => fixture(async (f) => {
  await db.execute(sql`update sov_lines set income_account_id=null where org_id=${f.org.orgId} and id=${f.sov}`);
  await refusedWithoutWrites(f, /Configured work.*Configure its income account before creating an invoice/);
}));

test("construction invoice uses explicit SOV account and skips unconfigured zero lines with exact decimals", enabled, async () => fixture(async (f) => {
  await generatedWithAccount(f, f.org.accounts.revenue);
}));

test("construction invoice preserves explicit non-income account flexibility", enabled, async () => fixture(async (f) => {
  // The construction API accepts any active, non-summary account in this org.
  await db.execute(sql`update sov_lines set income_account_id=${f.org.accounts.invAsset} where org_id=${f.org.orgId} and id=${f.sov}`);
  await generatedWithAccount(f, f.org.accounts.invAsset);
}));

for (const invalidity of ["inactive", "summary"] as const) {
  test(`construction invoice refuses ${invalidity} configured account without writes`, enabled, async () => fixture(async (f) => {
    if (invalidity === "inactive") await db.execute(sql`update accounts set is_active=false where org_id=${f.org.orgId} and id=${f.org.accounts.revenue}`);
    else await db.execute(sql`update accounts set is_summary=true where org_id=${f.org.orgId} and id=${f.org.accounts.revenue}`);
    await refusedWithoutWrites(f, /Configured work.*active, non-summary account in this organization/);
  }));
}

test("construction invoice skips unconfigured unchanged stored materials with zero gross", enabled, async () => fixture(async (f) => {
  await db.execute(sql`update pay_applications set status='draft' where org_id=${f.org.orgId} and id=${f.app}`);
  await db.execute(sql`update pay_application_lines set previous_completed='125.4321', previous_materials_stored='125.4321'
    where org_id=${f.org.orgId} and pay_application_id=${f.app} and sov_line_id=${f.idleSov}`);
  await withOrgTransaction(f.org.orgId, () => submitPayApplication(f.org.orgId, f.actor, f.app, [{ sovLineId: f.idleSov, thisPeriodCompleted: "0", materialsStored: "125.4321" }]));
  await withOrgTransaction(f.org.orgId, () => approvePayApplication(f.org.orgId, f.approver, f.app));
  await generatedWithAccount(f, f.org.accounts.revenue);
}));

for (const invalidity of ["nonexistent", "foreign-organization"] as const) {
  test(`construction invoice refuses ${invalidity} configured account without writes`, enabled, async () => fixture(async (f) => {
    const foreign = invalidity === "foreign-organization" ? await createScratchOrg() : null;
    try {
      await db.execute(sql`update sov_lines set income_account_id=${foreign?.accounts.revenue ?? randomUUID()} where org_id=${f.org.orgId} and id=${f.sov}`);
      await refusedWithoutWrites(f, /Configured work.*active, non-summary account in this organization/);
    } finally { if (foreign) await dropScratchOrgReporting(foreign.orgId); }
  }));
}
