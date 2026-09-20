import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  approvePayApplication,
  createPayApplication,
  generatePayApplicationInvoice,
  releaseRetainage,
  submitPayApplication,
} from "./construction-billing.ts";
import { cmp } from "../money/money.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  approveVendorPayApplication,
  createVendorPayApplication,
  generateVendorPayApplicationBill,
  releaseVendorRetainage,
  submitVendorPayApplication,
  updateVendorPayApplicationLines,
} from "./subcontracts.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function policyType(orgId: string, key: string): Promise<string> {
  const type = randomUUID();
  const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values(${type},${orgId},${key},'Settlement test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values(${orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch settlement policy')`);
  return type;
}

async function postInvoice(org: Org, actor: string, approver: string, kind: string, id: string): Promise<void> {
  assert.equal((await submitAndReleaseIfUngated(kind, id, actor)).autoApproved, true);
  await postDocument(
    id,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId: approver, source: "test" } },
  );
}

async function customerProject(org: Org, subsidiaryId: string, code: string): Promise<{ project: string; sov: string }> {
  const type = await policyType(org.orgId, `settle_${code}`);
  const project = randomUUID();
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
    values(${project},${org.orgId},${subsidiaryId},${code},'Settlement job',${org.customerId},${type},'active')`);
  await db.execute(sql`insert into sov_lines(org_id,project_id,description,scheduled_value,sort_order,income_account_id)
    values(${org.orgId},${project},'Work','10000',1,${org.accounts.revenue})`);
  const sov = (await db.execute<{ id: string }>(sql`select id from sov_lines where org_id=${org.orgId} and project_id=${project}`)).rows[0]!.id;
  return { project, sov };
}

async function customerDraw(
  org: Org, actor: string, approver: string, project: string, sov: string, work: string, date: string,
): Promise<{ invoiceId: string; retainage: string; currentDue: string }> {
  const app = await withOrgTransaction(org.orgId, () => createPayApplication(org.orgId, actor, project, date, "10"));
  await withOrgTransaction(org.orgId, () =>
    submitPayApplication(org.orgId, actor, app.id, [{ sovLineId: sov, thisPeriodCompleted: work, materialsStored: "0" }]));
  await withOrgTransaction(org.orgId, () => approvePayApplication(org.orgId, approver, app.id));
  const generated = await withOrgTransaction(org.orgId, () => generatePayApplicationInvoice(org.orgId, actor, app.id));
  await postInvoice(org, actor, approver, "customer_invoice", generated.invoiceId);
  return { invoiceId: generated.invoiceId, retainage: generated.retainage, currentDue: generated.currentDue };
}

async function customerHeld(org: Org, project: string): Promise<string> {
  const control = (await db.execute<{ id: string }>(sql`select settings->'controlAccounts'->>'retainageReceivable' as id from orgs where id=${org.orgId}`)).rows[0]!.id;
  return (await db.execute<{ held: string }>(sql`select coalesce(sum(amount),0)::text as held from journal_lines
    where org_id=${org.orgId} and project_id=${project} and account_id=${control}`)).rows[0]!.held;
}

test("customer consecutive draws settle cumulative cents with the residual carried", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Settlement controller", "admin");
    const approver = await createScratchUser(org.orgId, "Settlement approver", "admin");
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    const { project, sov } = await customerProject(org, org.subsidiaryId, "SET-CAD");
    const first = await customerDraw(org, actor, approver, project, sov, "333.33", org.date);
    assert.equal(first.retainage, "33.3300");
    const second = await customerDraw(org, actor, approver, project, sov, "333.33", "2026-07-16");
    // Cumulative exact 66.6666 rounds to 66.67; 33.33 already settled.
    assert.equal(second.retainage, "33.3400");
    assert.equal(cmp(await customerHeld(org, project), "66.67"), 0);
    // Releases sum to the settled total exactly, in whole cents.
    const rel = await withOrgTransaction(org.orgId, () => releaseRetainage(org.orgId, actor, project, "2026-07-17", "66.67"));
    await postInvoice(org, actor, approver, "customer_invoice", rel.invoiceId);
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("customer zero-decimal draws settle whole yen across draws", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Yen controller", "admin");
    const approver = await createScratchUser(org.orgId, "Yen approver", "admin");
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    await db.execute(sql`insert into currencies(code,name,minor_units) values('JPY','Japanese Yen',0) on conflict do nothing`);
    const subsidiary = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${subsidiary},${org.orgId},${org.subsidiaryId},'JP entity','JPY','JP')`);
    await db.execute(sql`insert into party_subsidiaries(id,org_id,party_id,subsidiary_id) values(${randomUUID()},${org.orgId},${org.customerId},${subsidiary})`);
    const { project, sov } = await customerProject(org, subsidiary, "SET-JPY");
    const first = await customerDraw(org, actor, approver, project, sov, "333.33", org.date);
    assert.equal(first.retainage, "33.0000");
    const second = await customerDraw(org, actor, approver, project, sov, "333.33", "2026-07-16");
    // Cumulative exact 66.666 rounds to 67 whole yen; 33 already settled.
    assert.equal(second.retainage, "34.0000");
    assert.equal(cmp(await customerHeld(org, project), "67"), 0);
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("customer fractional-cent releases are refused while whole-cent releases post", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Release controller", "admin");
    const approver = await createScratchUser(org.orgId, "Release approver", "admin");
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    const { project, sov } = await customerProject(org, org.subsidiaryId, "SET-REL");
    await customerDraw(org, actor, approver, project, sov, "1000", org.date);
    await assert.rejects(
      withOrgTransaction(org.orgId, () => releaseRetainage(org.orgId, actor, project, org.date, "10.005")),
      /whole minor units of CAD/,
    );
    const rel = await withOrgTransaction(org.orgId, () => releaseRetainage(org.orgId, actor, project, org.date, "10"));
    await postInvoice(org, actor, approver, "customer_invoice", rel.invoiceId);
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("vendor consecutive draws settle cumulative cents with the residual carried", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Vendor settlement controller", "admin");
    const approver = await createScratchUser(org.orgId, "Vendor settlement approver", "admin");
    const project = randomUUID(), vendor = randomUUID(), subcontract = randomUUID(), sov = randomUUID();
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text,'retainagePayable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    const type = await policyType(org.orgId, "settle_vendor");
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'SET-V','Vendor settlement job',${org.customerId},${type},'active')`);
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${org.orgId},'vendor','Vendor settlement vendor',true)`);
    await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,status) values(${subcontract},${org.orgId},${project},${vendor},'SC-SET','Vendor settlement scope','CAD','5000','active')`);
    await db.execute(sql`insert into subcontract_sov_lines(id,org_id,subcontract_id,description,scheduled_value,expense_account_id,sort_order) values(${sov},${org.orgId},${subcontract},'Work','10000',${org.accounts.cogs},1)`);
    const draw = async (work: string, date: string) => {
      const app = await withOrgTransaction(org.orgId, () => createVendorPayApplication({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: date }));
      await withOrgTransaction(org.orgId, () => updateVendorPayApplicationLines({ orgId: org.orgId, userId: actor, payApplicationId: app.id, lines: [{ sovLineId: sov, workCompletedThisPeriod: work, materialsStoredCurrent: "0" }] }));
      const submitted = await withOrgTransaction(org.orgId, () => submitVendorPayApplication(org.orgId, actor, app.id));
      await withOrgTransaction(org.orgId, () => approveVendorPayApplication(org.orgId, approver, app.id));
      const generated = await withOrgTransaction(org.orgId, () => generateVendorPayApplicationBill(org.orgId, actor, app.id));
      await postInvoice(org, actor, approver, "vendor_bill", generated.vendorBillDocumentId);
      return submitted.retainageThisPeriod;
    };
    assert.equal(await draw("333.33", org.date), "33.3300");
    assert.equal(await draw("333.33", "2026-07-16"), "33.3400");
    const held = (await db.execute<{ held: string }>(sql`select coalesce(sum(case when d.status = 'posted' then vpa.retainage_this_period else 0 end),0)::text as held
      from vendor_pay_applications vpa left join documents d on d.id = vpa.vendor_bill_document_id and d.org_id = vpa.org_id
      where vpa.org_id = ${org.orgId} and vpa.subcontract_id = ${subcontract} and vpa.status = 'billed'`)).rows[0]!.held;
    assert.equal(cmp(held, "66.67"), 0);
    await assert.rejects(
      withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: "2026-07-17", amount: "10.005" })),
      /whole minor units of CAD/,
    );
    const rel = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: "2026-07-17", amount: "66.67" }));
    await postInvoice(org, actor, approver, "vendor_bill", rel.vendorBillDocumentId);
  } finally { await dropScratchOrgReporting(org.orgId); }
});
