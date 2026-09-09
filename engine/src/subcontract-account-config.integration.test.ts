import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";
import {
  addSubcontractSovLine,
  approveVendorPayApplication,
  createVendorPayApplication,
  generateVendorPayApplicationBill,
  SubcontractError,
  submitVendorPayApplication,
  updateVendorPayApplicationLines,
} from "./subcontracts.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Org = Awaited<ReturnType<typeof createScratchOrg>>;
type Fixture = { org: Org; actor: string; approver: string; subcontract: string; sov: string; idleSov: string; app: string };

async function fixture(run: (f: Fixture) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Subcontract account controller", "admin");
    const approver = await createScratchUser(org.orgId, "Subcontract account approver", "admin");
    const project = randomUUID(), type = randomUUID(), subcontract = randomUUID();
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true}'::jsonb) where id=${org.orgId}`);
    const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${type},${org.orgId},'subcontract_accounts_test','Subcontract accounts test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch subcontract account policy')`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'SCA','Subcontract account job',${org.customerId},${type},'active')`);
    await db.execute(sql`insert into vendor_roles(org_id,party_id) values(${org.orgId},${org.vendorId})`);
    await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,default_retainage_percent,status)
      values(${subcontract},${org.orgId},${project},${org.vendorId},'SC-ACCOUNT','Configured accounts','CAD','5000','0','draft')`);
    // The public SOV API already permits an explicit capitalization account.
    const sov = (await withOrgTransaction(org.orgId, () => addSubcontractSovLine({ orgId: org.orgId, userId: actor, subcontractId: subcontract, description: "Capitalized work", scheduledValue: "4000", expenseAccountId: org.accounts.invAsset, sortOrder: 1 }))).id;
    const idleSov = (await withOrgTransaction(org.orgId, () => addSubcontractSovLine({ orgId: org.orgId, userId: actor, subcontractId: subcontract, description: "Unbilled work", scheduledValue: "1000", sortOrder: 2 }))).id;
    await db.execute(sql`update subcontracts set status='active' where org_id=${org.orgId} and id=${subcontract}`);
    const app = (await withOrgTransaction(org.orgId, () => createVendorPayApplication({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date }))).id;
    await withOrgTransaction(org.orgId, () => updateVendorPayApplicationLines({ orgId: org.orgId, userId: actor, payApplicationId: app, lines: [{ sovLineId: sov, workCompletedThisPeriod: "1000.1234", materialsStoredCurrent: "0" }] }));
    await withOrgTransaction(org.orgId, () => submitVendorPayApplication(org.orgId, actor, app));
    await withOrgTransaction(org.orgId, () => approveVendorPayApplication(org.orgId, approver, app));
    await run({ org, actor, approver, subcontract, sov, idleSov, app });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

async function setAccounts(f: Fixture, sovAccount: string | null, vendorAccount: string | null) {
  await db.execute(sql`update subcontract_sov_lines set expense_account_id=${sovAccount} where org_id=${f.org.orgId} and id=${f.sov}`);
  await db.execute(sql`update vendor_roles set default_expense_account_id=${vendorAccount} where org_id=${f.org.orgId} and party_id=${f.org.vendorId}`);
}

async function snapshot(f: Fixture) {
  return (await db.execute(sql`
    select
      (select to_jsonb(a) from vendor_pay_applications a where a.org_id=${f.org.orgId} and a.id=${f.app}) as application,
      (select jsonb_agg(to_jsonb(l) order by l.id) from vendor_pay_application_lines l where l.org_id=${f.org.orgId} and l.pay_application_id=${f.app}) as source_lines,
      (select jsonb_agg(to_jsonb(d) order by d.id) from documents d where d.org_id=${f.org.orgId}) as documents,
      (select jsonb_agg(to_jsonb(l) order by l.id) from document_lines l where l.org_id=${f.org.orgId}) as bill_lines,
      (select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where a.org_id=${f.org.orgId}) as audit
  `)).rows[0];
}

async function refusedWithoutWrites(f: Fixture, message: RegExp) {
  const before = await snapshot(f);
  await assert.rejects(withOrgTransaction(f.org.orgId, () => generateVendorPayApplicationBill(f.org.orgId, f.actor, f.app)),
    (error: unknown) => error instanceof SubcontractError && message.test(error.message));
  assert.deepEqual(await snapshot(f), before, "refusal must preserve source, bill rows, and audit evidence exactly");
}

async function generatedWithAccount(f: Fixture, accountId: string) {
  const generated = await withOrgTransaction(f.org.orgId, () => generateVendorPayApplicationBill(f.org.orgId, f.actor, f.app));
  const lines = (await db.execute(sql`select account_id, amount::text, unit_price::text from document_lines where org_id=${f.org.orgId} and document_id=${generated.vendorBillDocumentId} order by line_number`)).rows;
  assert.deepEqual(lines, [{ account_id: accountId, amount: "1000.1234", unit_price: "1000.12340000" }]);
  assert.equal(generated.netDue, "1000.1234");
  const source = (await db.execute(sql`select status, vendor_bill_document_id from vendor_pay_applications where org_id=${f.org.orgId} and id=${f.app}`)).rows[0];
  assert.deepEqual(source, { status: "billed", vendor_bill_document_id: generated.vendorBillDocumentId });
  assert.deepEqual(await withOrgTransaction(f.org.orgId, () => generateVendorPayApplicationBill(f.org.orgId, f.actor, f.app)), generated, "generation remains idempotent");
}

test("subcontract bill refuses missing configuration despite available chart expense accounts without source mutation", enabled, async () => fixture(async (f) => {
  await setAccounts(f, null, null);
  await refusedWithoutWrites(f, /Capitalized work.*Configure its expense account or the vendor's default expense account/);
}));

test("subcontract bill uses explicit SOV account before vendor default", enabled, async () => fixture(async (f) => {
  await setAccounts(f, f.org.accounts.cogs, f.org.accounts.freight);
  await generatedWithAccount(f, f.org.accounts.cogs);
}));

test("subcontract bill uses configured vendor default when SOV has no account", enabled, async () => fixture(async (f) => {
  await setAccounts(f, null, f.org.accounts.freight);
  await generatedWithAccount(f, f.org.accounts.freight);
}));

test("subcontract bill preserves explicit capitalization accounts and skips unconfigured zero lines", enabled, async () => fixture(async (f) => {
  await generatedWithAccount(f, f.org.accounts.invAsset);
}));

for (const source of ["SOV", "vendor"] as const) {
  for (const invalidity of ["inactive", "summary"] as const) {
    test(`subcontract bill refuses ${invalidity} ${source} account without writes or fallback`, enabled, async () => fixture(async (f) => {
      await setAccounts(f, source === "SOV" ? f.org.accounts.cogs : null, source === "SOV" ? f.org.accounts.freight : f.org.accounts.cogs);
      if (invalidity === "inactive") await db.execute(sql`update accounts set is_active=false where org_id=${f.org.orgId} and id=${f.org.accounts.cogs}`);
      else await db.execute(sql`update accounts set is_summary=true where org_id=${f.org.orgId} and id=${f.org.accounts.cogs}`);
      await refusedWithoutWrites(f, /active, non-summary account in this organization/);
    }));
  }
}

// Composite foreign keys reject nonexistent/foreign references at configuration
// time, so these states cannot be persisted for a generation-time test.
for (const source of ["SOV", "vendor"] as const) {
  for (const invalidity of ["nonexistent", "foreign-organization"] as const) {
    test(`subcontract ${source} configuration rejects ${invalidity} account before bill generation`, enabled, async () => fixture(async (f) => {
      const foreign = invalidity === "foreign-organization" ? await createScratchOrg() : null;
      try {
        const invalidAccount = foreign?.accounts.cogs ?? randomUUID();
        const before = await snapshot(f);
        await assert.rejects(withOrgTransaction(f.org.orgId, () => setAccounts(f,
          source === "SOV" ? invalidAccount : null,
          source === "SOV" ? f.org.accounts.freight : invalidAccount,
        )), (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23503");
        assert.deepEqual(await snapshot(f), before);
        await generatedWithAccount(f, f.org.accounts.invAsset);
      } finally { if (foreign) await dropScratchOrgReporting(foreign.orgId); }
    }));
  }
}

test("subcontract bill skips unconfigured stored-material transfer with zero gross", enabled, async () => fixture(async (f) => {
  // Seed prior stored-material evidence, then submit a new application through
  // the normal workflow: installation offsets the reduction in stored stock.
  await db.execute(sql`update vendor_pay_applications set status='draft' where org_id=${f.org.orgId} and id=${f.app}`);
  await db.execute(sql`update vendor_pay_application_lines set previous_earned='125.4321', previous_materials_stored='125.4321'
    where org_id=${f.org.orgId} and pay_application_id=${f.app} and sov_line_id=${f.idleSov}`);
  await withOrgTransaction(f.org.orgId, () => updateVendorPayApplicationLines({ orgId: f.org.orgId, userId: f.actor, payApplicationId: f.app, lines: [{ sovLineId: f.idleSov, workCompletedThisPeriod: "125.4321", materialsStoredCurrent: "0" }] }));
  await withOrgTransaction(f.org.orgId, () => submitVendorPayApplication(f.org.orgId, f.actor, f.app));
  await withOrgTransaction(f.org.orgId, () => approveVendorPayApplication(f.org.orgId, f.approver, f.app));
  await generatedWithAccount(f, f.org.accounts.invAsset);
}));
