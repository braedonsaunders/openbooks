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
import { deleteDocument } from "../ledger/document-delete.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { reverseProjectGlEntry } from "./recognition.ts";
import { cmp } from "../money/money.ts";
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

async function postCustomerInvoice(org: Org, actor: string, approver: string, id: string): Promise<void> {
  assert.equal((await submitAndReleaseIfUngated("customer_invoice", id, actor)).autoApproved, true);
  await postDocument(
    id,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId: approver, source: "test" } },
  );
}

async function postVendorBill(org: Org, actor: string, approver: string, id: string): Promise<void> {
  assert.equal((await submitAndReleaseIfUngated("vendor_bill", id, actor)).autoApproved, true);
  await postDocument(
    id,
    { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } },
    { audit: { actorId: approver, source: "test" } },
  );
}

async function voidDoc(orgId: string, actorId: string, documentId: string, date: string): Promise<void> {
  const result = await requestDocumentVoid({
    orgId,
    actorId,
    documentId,
    reason: "Lifecycle test reversal",
    reversalDate: date,
  });
  assert.equal(result.status, "voided");
}

async function customerSetup(): Promise<{
  org: Org; actor: string; approver: string; project: string; release: (amount: string, date?: string) => Promise<{ invoiceId: string }>;
  draw: (work: string, date: string, retainage?: string) => Promise<{ invoiceId: string; retained: string }>;
}> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Lifecycle controller", "admin");
  const approver = await createScratchUser(org.orgId, "Lifecycle approver", "admin");
  const project = randomUUID(), type = randomUUID(), sov = randomUUID();
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
  const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values(${type},${org.orgId},'lifecycle_test','Lifecycle test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch lifecycle policy')`);
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
    values(${project},${org.orgId},${org.subsidiaryId},'LIFE','Lifecycle job',${org.customerId},${type},'active')`);
  await db.execute(sql`insert into sov_lines(org_id,project_id,description,scheduled_value,sort_order,income_account_id)
    values(${org.orgId},${project},'Work','10000',1,${org.accounts.revenue})`);
  const sovId = (
    await db.execute<{ id: string }>(sql`select id from sov_lines where org_id=${org.orgId} and project_id=${project}`)
  ).rows[0]!.id;
  void sov;
  const draw = async (work: string, date: string, retainage = "10") => {
    const app = await withOrgTransaction(org.orgId, () => createPayApplication(org.orgId, actor, project, date, retainage));
    await withOrgTransaction(org.orgId, () =>
      submitPayApplication(org.orgId, actor, app.id, [{ sovLineId: sovId, thisPeriodCompleted: work, materialsStored: "0" }]));
    await withOrgTransaction(org.orgId, () => approvePayApplication(org.orgId, approver, app.id));
    const generated = await withOrgTransaction(org.orgId, () => generatePayApplicationInvoice(org.orgId, actor, app.id));
    await postCustomerInvoice(org, actor, approver, generated.invoiceId);
    return { invoiceId: generated.invoiceId, retained: generated.retainage };
  };
  const release = async (amount: string, date?: string) =>
    withOrgTransaction(org.orgId, () => releaseRetainage(org.orgId, actor, project, date ?? org.date, amount));
  return { org, actor, approver, project, release, draw };
}

async function vendorSetup(): Promise<{
  org: Org; actor: string; approver: string; subcontract: string;
  release: (amount: string) => Promise<{ vendorBillDocumentId: string }>;
}> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "Vendor lifecycle controller", "admin");
  const approver = await createScratchUser(org.orgId, "Vendor lifecycle approver", "admin");
  const project = randomUUID(), type = randomUUID();
  const vendor = randomUUID(), subcontract = randomUUID(), sov = randomUUID();
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true}'::jsonb) where id=${org.orgId}`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text,'retainagePayable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
  const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values(${type},${org.orgId},'vendor_lifecycle_test','Vendor lifecycle test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch vendor lifecycle policy')`);
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
    values(${project},${org.orgId},${org.subsidiaryId},'VLIFE','Vendor lifecycle job',${org.customerId},${type},'active')`);
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${org.orgId},'vendor','Vendor lifecycle vendor',true)`);
  await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,status) values(${subcontract},${org.orgId},${project},${vendor},'SC-VLIFE','Vendor lifecycle scope','CAD','5000','active')`);
  await db.execute(sql`insert into subcontract_sov_lines(id,org_id,subcontract_id,description,scheduled_value,expense_account_id,sort_order) values(${sov},${org.orgId},${subcontract},'Work','10000',${org.accounts.cogs},1)`);
  const app = await withOrgTransaction(org.orgId, () => createVendorPayApplication({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date }));
  await withOrgTransaction(org.orgId, () => updateVendorPayApplicationLines({ orgId: org.orgId, userId: actor, payApplicationId: app.id, expectedRevision: 1, lines: [{ sovLineId: sov, workCompletedThisPeriod: "1000", materialsStoredCurrent: "0" }] }));
  await withOrgTransaction(org.orgId, () => submitVendorPayApplication(org.orgId, actor, app.id));
  await withOrgTransaction(org.orgId, () => approveVendorPayApplication(org.orgId, approver, app.id));
  const generated = await withOrgTransaction(org.orgId, () => generateVendorPayApplicationBill(org.orgId, actor, app.id));
  await postVendorBill(org, actor, approver, generated.vendorBillDocumentId);
  const release = async (amount: string) =>
    withOrgTransaction(org.orgId, () =>
      releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount }));
  return { org, actor, approver, subcontract, release };
}

test("customer draw void refuses while a draft release depends on it, then succeeds after the release is discarded", enabled, async () => {
  const f = await customerSetup();
  try {
    const draw = await f.draw("1000", f.org.date);
    assert.equal(draw.retained, "100.0000");
    const rel = await f.release("60");
    await assert.rejects(voidDoc(f.org.orgId, f.actor, draw.invoiceId, f.org.date), /retainage release/);
    await withOrgTransaction(f.org.orgId, () => deleteDocument(rel.invoiceId, f.actor, f.org.orgId, { reason: "Discard draft release" }));
    await voidDoc(f.org.orgId, f.actor, draw.invoiceId, f.org.date);
    // The draw application reopens for regeneration and capacity is restored.
    const reopened = (await db.execute<{ id: string; status: string }>(sql`select id, status from pay_applications where org_id=${f.org.orgId} and kind = 'progress'`)).rows[0]!;
    assert.equal(reopened.status, "approved");
    const regenerated = await withOrgTransaction(f.org.orgId, () => generatePayApplicationInvoice(f.org.orgId, f.actor, reopened.id));
    assert.equal(regenerated.retainage, "100.0000");
    await postCustomerInvoice(f.org, f.actor, f.approver, regenerated.invoiceId);
    const replacement = await f.release("100");
    await postCustomerInvoice(f.org, f.actor, f.approver, replacement.invoiceId);
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("customer partial release reversed first permits the supporting draw void", enabled, async () => {
  const f = await customerSetup();
  try {
    const draw = await f.draw("1000", f.org.date);
    const rel = await f.release("40");
    await postCustomerInvoice(f.org, f.actor, f.approver, rel.invoiceId);
    await voidDoc(f.org.orgId, f.actor, rel.invoiceId, f.org.date);
    await voidDoc(f.org.orgId, f.actor, draw.invoiceId, f.org.date);
    const held = (await db.execute<{ held: string }>(sql`select coalesce(sum(amount),0)::text as held from journal_lines where org_id=${f.org.orgId}`)).rows[0]!.held;
    assert.equal(cmp(held, "0"), 0);
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("vendor draw-bill void refuses while a draft release depends on it, then succeeds after the release is discarded", enabled, async () => {
  const f = await vendorSetup();
  try {
    const bill = (await db.execute<{ id: string }>(sql`select vendor_bill_document_id as id from vendor_pay_applications where org_id=${f.org.orgId}`)).rows[0]!.id;
    const rel = await f.release("60");
    await assert.rejects(voidDoc(f.org.orgId, f.actor, bill, f.org.date), /retainage release/);
    await withOrgTransaction(f.org.orgId, () => deleteDocument(rel.vendorBillDocumentId, f.actor, f.org.orgId, { reason: "Discard draft release" }));
    await voidDoc(f.org.orgId, f.actor, bill, f.org.date);
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("vendor partial release reversed first permits the supporting draw-bill void", enabled, async () => {
  const f = await vendorSetup();
  try {
    const bill = (await db.execute<{ id: string }>(sql`select vendor_bill_document_id as id from vendor_pay_applications where org_id=${f.org.orgId}`)).rows[0]!.id;
    const rel = await f.release("40");
    await postVendorBill(f.org, f.actor, f.approver, rel.vendorBillDocumentId);
    await voidDoc(f.org.orgId, f.actor, rel.vendorBillDocumentId, f.org.date);
    await voidDoc(f.org.orgId, f.actor, bill, f.org.date);
    const status = (await db.execute<{ status: string }>(sql`select status from vendor_pay_applications where org_id=${f.org.orgId}`)).rows[0]!.status;
    assert.equal(status, "approved");
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("vendor draw-bill void writes an audited application release", enabled, async () => {
  // A-S32: the application's return to billable must carry the void actor,
  // the reason, and the before/after status and bill link — the same
  // evidence the customer-side release writes — instead of a silent flip.
  const f = await vendorSetup();
  try {
    const app = (await db.execute<{ id: string }>(sql`select id from vendor_pay_applications where org_id=${f.org.orgId}`)).rows[0]!;
    const bill = (await db.execute<{ id: string }>(sql`select vendor_bill_document_id as id from vendor_pay_applications where org_id=${f.org.orgId}`)).rows[0]!.id;
    await voidDoc(f.org.orgId, f.actor, bill, f.org.date);
    const released = (await db.execute<{ status: string; vendor_bill_document_id: string | null; updated_by: string | null }>(sql`
      select status, vendor_bill_document_id, updated_by from vendor_pay_applications where org_id=${f.org.orgId} and id=${app.id}`)).rows[0]!;
    assert.equal(released.status, "approved");
    assert.equal(released.vendor_bill_document_id, null);
    assert.equal(released.updated_by, f.actor);
    const audit = (await db.execute<{ action: string; changes: unknown; actor_id: string | null }>(sql`
      select action, changes, actor_id from audit_log
       where org_id=${f.org.orgId} and table_name='vendor_pay_applications' and row_id=${app.id} and action='billing_released'
       order by at desc limit 1`)).rows[0]!;
    assert.equal(audit.action, "billing_released");
    assert.equal(audit.actor_id, f.actor);
    const changes = audit.changes as { before: { status: string; vendor_bill_document_id: string }; after: { status: string; vendor_bill_document_id: null }; reason: string };
    assert.equal(changes.before.status, "billed");
    assert.equal(changes.before.vendor_bill_document_id, bill);
    assert.equal(changes.after.status, "approved");
    assert.equal(changes.after.vendor_bill_document_id, null);
    assert.equal(changes.reason, "Lifecycle test reversal");
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("customer release posting refuses shrunken capacity instead of over-releasing", enabled, async () => {
  const f = await customerSetup();
  try {
    const draw = await f.draw("1000", f.org.date);
    const rel = await f.release("60");
    const entry = (await db.execute<{ id: string }>(sql`select posted_entry_id as id from documents where org_id=${f.org.orgId} and id=${draw.invoiceId}`)).rows[0]!.id;
    await reverseProjectGlEntry(f.org.orgId, f.actor, entry, "Correct retained amount", f.org.date);
    await assert.rejects(postCustomerInvoice(f.org, f.actor, f.approver, rel.invoiceId), /retainage/i);
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("vendor release posting refuses capacity consumed by a bypass reservation", enabled, async () => {
  const f = await vendorSetup();
  try {
    const rel = await f.release("60");
    // A second reservation that bypassed creation-time capacity (legacy/state
    // repair): a draft bill with its own release row consuming 50 of the 100 held.
    const billId = randomUUID(), releaseId = randomUUID();
    const control = (await db.execute<{ id: string }>(sql`select settings->'controlAccounts'->>'retainagePayable' as id from orgs where id=${f.org.orgId}`)).rows[0]!.id;
    const subcontract = (await db.execute<{ project_id: string; vendor_id: string }>(sql`select project_id, vendor_id from subcontracts where org_id=${f.org.orgId} and id=${f.subcontract}`)).rows[0]!;
    await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,status,project_id,subsidiary_id,memo,subtotal,tax_total,total,custom,created_by,updated_by)
      values(${billId},${f.org.orgId},'vendor_bill',${`BILL-${billId.slice(0, 8)}`},${subcontract.vendor_id},${f.org.date},'CAD','draft',${subcontract.project_id},${f.org.subsidiaryId},'Bypass reservation','50','0','50',${JSON.stringify({ subcontractId: f.subcontract, kind: "retainage_release" })}::jsonb,${f.actor},${f.actor})`);
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,project_id,party_id,is_billable,created_by,updated_by)
      values(${f.org.orgId},${billId},1,${control},'Retainage release','1','50','50',${subcontract.project_id},${subcontract.vendor_id},false,${f.actor},${f.actor})`);
    await db.execute(sql`insert into vendor_retainage_releases(id,org_id,subcontract_id,period_end,amount,vendor_bill_document_id,created_by,updated_by)
      values(${releaseId},${f.org.orgId},${f.subcontract},${f.org.date},'50',${billId},${f.actor},${f.actor})`);
    await assert.rejects(postVendorBill(f.org, f.actor, f.approver, rel.vendorBillDocumentId), /retainage/i);
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("customer multi-currency draw void refuses while a release depends on it", enabled, async () => {
  const f = await customerSetup();
  try {
    await db.execute(sql`insert into currencies(code,name,minor_units) values('USD','US Dollar',2) on conflict do nothing`);
    const subsidiary = randomUUID(), project = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${subsidiary},${f.org.orgId},${f.org.subsidiaryId},'US entity','USD','US')`);
    await db.execute(sql`insert into party_subsidiaries(id,org_id,party_id,subsidiary_id) values(${randomUUID()},${f.org.orgId},${f.org.customerId},${subsidiary})`);
    const type = (await db.execute<{ id: string }>(sql`select project_type_id as id from projects where org_id=${f.org.orgId} and id=${f.project}`)).rows[0]!.id;
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${f.org.orgId},${subsidiary},'LIFE-USD','Lifecycle USD job',${f.org.customerId},${type},'active')`);
    await db.execute(sql`insert into sov_lines(org_id,project_id,description,scheduled_value,sort_order,income_account_id)
      values(${f.org.orgId},${project},'Work','10000',1,${f.org.accounts.revenue})`);
    const sovId = (await db.execute<{ id: string }>(sql`select id from sov_lines where org_id=${f.org.orgId} and project_id=${project}`)).rows[0]!.id;
    const app = await withOrgTransaction(f.org.orgId, () => createPayApplication(f.org.orgId, f.actor, project, f.org.date, "10"));
    await withOrgTransaction(f.org.orgId, () =>
      submitPayApplication(f.org.orgId, f.actor, app.id, [{ sovLineId: sovId, thisPeriodCompleted: "1000", materialsStored: "0" }]));
    await withOrgTransaction(f.org.orgId, () => approvePayApplication(f.org.orgId, f.approver, app.id));
    const generated = await withOrgTransaction(f.org.orgId, () => generatePayApplicationInvoice(f.org.orgId, f.actor, app.id));
    assert.equal(generated.retainage, "100.0000");
    await postCustomerInvoice(f.org, f.actor, f.approver, generated.invoiceId);
    const currency = (await db.execute<{ currency: string }>(sql`select currency from documents where org_id=${f.org.orgId} and id=${generated.invoiceId}`)).rows[0]!.currency;
    assert.equal(currency, "USD");
    const rel = await withOrgTransaction(f.org.orgId, () => releaseRetainage(f.org.orgId, f.actor, project, f.org.date, "60"));
    await assert.rejects(voidDoc(f.org.orgId, f.actor, generated.invoiceId, f.org.date), /retainage release/);
    await withOrgTransaction(f.org.orgId, () => deleteDocument(rel.invoiceId, f.actor, f.org.orgId, { reason: "Discard USD release" }));
    await voidDoc(f.org.orgId, f.actor, generated.invoiceId, f.org.date);
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});
