import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";



import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { postDocument } from "./posting.ts";
import {
  approveVendorPayApplication,
  createVendorPayApplication,
  generateVendorPayApplicationBill,
  releaseVendorRetainage,
  submitVendorPayApplication,
  updateVendorPayApplicationLines,
} from "./subcontracts.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function fixture(run: (f: {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  actor: string;
  approver: string;
  subcontract: string;
  project: string;
  sov: string;
}) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Vendor retainage controller", "admin");
    const approver = await createScratchUser(org.orgId, "Vendor retainage approver", "admin");
    const project = randomUUID(), type = randomUUID();
    const vendor = randomUUID(), subcontract = randomUUID(), sov = randomUUID();
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.taxInput}::text,'retainagePayable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${type},${org.orgId},'billing_integrity_test','Vendor retainage delete test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch vendor retainage policy')`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'VRET','Vendor retainage job',${org.customerId},${type},'active')`);
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${org.orgId},'vendor','Vendor retainage vendor',true)`);
    await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,status) values(${subcontract},${org.orgId},${project},${vendor},'SC-VRET','Vendor retainage scope','CAD','5000','active')`);
    await db.execute(sql`insert into subcontract_sov_lines(id,org_id,subcontract_id,description,scheduled_value,expense_account_id,sort_order) values(${sov},${org.orgId},${subcontract},'Work','2000',${org.accounts.cogs},1)`);
    const app = await withOrgTransaction(org.orgId, () => createVendorPayApplication({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date }));
    await withOrgTransaction(org.orgId, () => updateVendorPayApplicationLines({ orgId: org.orgId, userId: actor, payApplicationId: app.id, lines: [{ sovLineId: sov, workCompletedThisPeriod: "1000", materialsStoredCurrent: "0" }] }));
    await withOrgTransaction(org.orgId, () => submitVendorPayApplication(org.orgId, actor, app.id));
    await withOrgTransaction(org.orgId, () => approveVendorPayApplication(org.orgId, approver, app.id));
    const generated = await withOrgTransaction(org.orgId, () => generateVendorPayApplicationBill(org.orgId, actor, app.id));
    assert.equal((await submitAndReleaseIfUngated("vendor_bill", generated.vendorBillDocumentId, actor)).autoApproved, true);
    await postDocument(generated.vendorBillDocumentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }, { audit: { actorId: approver, source: "test" } });
    await run({ org, actor, approver, subcontract, project, sov });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  return next(specifier, context);
}});
const { applyDocumentEdit, loadDocumentEditCurrent } = await import("../../web/lib/documents.ts");
import { createPayApplication, submitPayApplication, approvePayApplication, generatePayApplicationInvoice, releaseRetainage } from "./construction-billing.ts";
import { cmp, neg } from "./money.ts";
import { assertGeneratedBillingEdit } from "./billing-source-integrity.ts";
type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
async function edit(f: Fixture, id: string, patch: Parameters<typeof applyDocumentEdit>[2]) {
  await withOrgTransaction(f.org.orgId, async () => {
    const current = await loadDocumentEditCurrent(id, f.org.orgId);
    assert.ok(current);
    await applyDocumentEdit(id, current, { ...patch, expectedUpdatedAt: current.updatedAt }, { orgId: f.org.orgId, userId: f.actor, source: "ui" });
  });
}
async function lines(f: Fixture, id: string) {
  return (await db.execute<NonNullable<Parameters<typeof applyDocumentEdit>[2]["lines"]>[number] & Record<string, unknown>>(sql`
    select account_id as "accountId", item_id as "itemId", description, quantity, unit,
      unit_price::numeric(19,4)::text as "unitPrice", amount, tax_code_id as "taxCodeId",
      party_id as "partyId", department_id as "departmentId", project_id as "projectId",
      location_id as "locationId", class_id as "classId", stock_location_id as "stockLocationId", extra_dims as "extraDims", custom
    from document_lines where org_id=${f.org.orgId} and document_id=${id} order by line_number
  `)).rows;
}
async function snapshot(f: Fixture, id: string) {
  return (await db.execute(sql`select
    (select to_jsonb(d) from documents d where org_id=${f.org.orgId} and id=${id}) as document,
    (select jsonb_agg(to_jsonb(l) order by line_number) from document_lines l where org_id=${f.org.orgId} and document_id=${id}) as lines,
    (select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id=${f.org.orgId}) as audit,
    (select jsonb_agg(to_jsonb(a) order by id) from vendor_pay_applications a where org_id=${f.org.orgId}) as vendor_apps,
    (select jsonb_agg(to_jsonb(a) order by id) from vendor_retainage_releases a where org_id=${f.org.orgId}) as vendor_releases,
    (select jsonb_agg(to_jsonb(a) order by id) from pay_applications a where org_id=${f.org.orgId}) as customer_apps,
    (select count(*) from journal_entries where org_id=${f.org.orgId}) as entries
  `)).rows[0];
}
async function refuseEdit(f: Fixture, id: string, patch: Parameters<typeof applyDocumentEdit>[2]) {
  const before = await snapshot(f, id);
  await assert.rejects(edit(f, id, patch), /source billing workflow/);
  assert.deepEqual(await snapshot(f, id), before);
}
async function post(f: Fixture, id: string, kind = "vendor_bill") {
  assert.equal((await submitAndReleaseIfUngated(kind, id, f.actor)).autoApproved, true);
  await postDocument(id, { control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank } }, { audit: { actorId: f.approver, source: "test" } });
}
async function refusePost(f: Fixture, id: string, kind = "vendor_bill") {
  assert.equal((await submitAndReleaseIfUngated(kind, id, f.actor)).autoApproved, true);
  const before = await snapshot(f, id);
  await assert.rejects(postDocument(id, { control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank } }, { audit: { actorId: f.approver, source: "test" } }), /source billing workflow/);
  assert.deepEqual(await snapshot(f, id), before);
}
async function vendorBill(f: Fixture) {
  const app = await withOrgTransaction(f.org.orgId, () => createVendorPayApplication({ orgId: f.org.orgId, userId: f.actor, subcontractId: f.subcontract, periodEnd: "2026-07-16" }));
  await withOrgTransaction(f.org.orgId, () => updateVendorPayApplicationLines({ orgId: f.org.orgId, userId: f.actor, payApplicationId: app.id, lines: [{ sovLineId: f.sov, workCompletedThisPeriod: "500", materialsStoredCurrent: "0" }] }));
  await withOrgTransaction(f.org.orgId, () => submitVendorPayApplication(f.org.orgId, f.actor, app.id));
  await withOrgTransaction(f.org.orgId, () => approveVendorPayApplication(f.org.orgId, f.approver, app.id));
  return (await withOrgTransaction(f.org.orgId, () => generateVendorPayApplicationBill(f.org.orgId, f.actor, app.id))).vendorBillDocumentId;
}
async function vendorRelease(f: Fixture) {
  return (await withOrgTransaction(f.org.orgId, () => releaseVendorRetainage({ orgId: f.org.orgId, userId: f.actor, subcontractId: f.subcontract, periodEnd: f.org.date, amount: "100" }))).vendorBillDocumentId;
}
async function customerProgress(f: Fixture, retainage = "10") {
  const sov = randomUUID();
  await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,sort_order,income_account_id) values(${sov},${f.org.orgId},${f.project},'Customer work','1000',1,${f.org.accounts.revenue})`);
  const app = await withOrgTransaction(f.org.orgId, () => createPayApplication(f.org.orgId, f.actor, f.project, f.org.date, retainage));
  await withOrgTransaction(f.org.orgId, () => submitPayApplication(f.org.orgId, f.actor, app.id, [{ sovLineId: sov, thisPeriodCompleted: "500", materialsStored: "0" }]));
  await withOrgTransaction(f.org.orgId, () => approvePayApplication(f.org.orgId, f.approver, app.id));
  return (await withOrgTransaction(f.org.orgId, () => generatePayApplicationInvoice(f.org.orgId, f.actor, app.id))).invoiceId;
}

async function beforePostScript(f: Fixture, kind: string, values: Record<string, string>) {
  const id = randomUUID();
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,scripts}','true') where id=${f.org.orgId}`);
  await db.execute(sql`insert into user_scripts(id,org_id,name,trigger_point,document_kind,source,timeout_ms,sort_order,is_active)
    values(${id},${f.org.orgId},'Generated billing dimension assignment','before_post',${kind},
      ${`function main() { return { set: ${JSON.stringify(values)} }; }`},2000,100,true)`);
  return id;
}

for (const customer of [false, true]) {
  const kind = customer ? "customer_invoice" : "vendor_bill";
  test(`${kind} posts with real before_post dimension assignments on its first attempt`, enabled, async () => fixture(async f => {
    const id = customer ? await customerProgress(f) : await vendorBill(f);
    const dimensions = { departmentId: randomUUID(), locationId: randomUUID(), classId: randomUUID() };
    await db.execute(sql`insert into departments(id,org_id,name) values(${dimensions.departmentId},${f.org.orgId},'Billing department')`);
    await db.execute(sql`insert into locations(id,org_id,name) values(${dimensions.locationId},${f.org.orgId},'Billing location')`);
    await db.execute(sql`insert into classes(id,org_id,name) values(${dimensions.classId},${f.org.orgId},'Billing class')`);
    const scriptId = await beforePostScript(f, kind, dimensions);
    await withOrgTransaction(f.org.orgId, () => post(f, id, kind));
    const journal = (await db.execute<{ departmentId: string; locationId: string; classId: string }>(sql`
      select l.department_id as "departmentId",l.location_id as "locationId",l.class_id as "classId"
      from journal_lines l join documents d on d.org_id=l.org_id and d.posted_entry_id=l.entry_id
      where d.org_id=${f.org.orgId} and d.id=${id}
    `)).rows;
    assert.ok(journal.length > 0, 'the first posting attempt must create journal lines');
    for (const line of journal) assert.deepEqual(line, dimensions);
    const evidence = (await db.execute<{ status: string }>(sql`select status from script_runs
      where org_id=${f.org.orgId} and script_id=${scriptId} and target_id=${id}`)).rows;
    assert.deepEqual(evidence, [{ status: "ok" }], 'the real script must execute exactly once');
  }));

  test(`${kind} refuses before_post source project replacement and rolls back automation evidence`, enabled, async () => fixture(async f => {
    const id = customer ? await customerProgress(f) : await vendorBill(f);
    const otherProject = randomUUID();
    await db.execute(sql`insert into projects(id,org_id,name,subsidiary_id,customer_id,status)
      values(${otherProject},${f.org.orgId},'Different valid project',${f.org.subsidiaryId},${f.org.customerId},'active')`);
    const scriptId = await beforePostScript(f, kind, { projectId: otherProject });
    assert.equal((await submitAndReleaseIfUngated(kind, id, f.actor)).autoApproved, true);
    const before = await snapshot(f, id);
    await assert.rejects(withOrgTransaction(f.org.orgId, () => postDocument(id,
      { control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank } },
      { audit: { actorId: f.approver, source: "test" } })), /source billing workflow/);
    assert.deepEqual(await snapshot(f, id), before, 'posting must roll back the source-project mutation and all accounting writes');
    const evidence = (await db.execute(sql`select id from script_runs
      where org_id=${f.org.orgId} and script_id=${scriptId} and target_id=${id}`)).rows;
    assert.deepEqual(evidence, [], 'failed posting must roll back script execution evidence');
  }));
}

for (const scenario of ["vendor release", "vendor application", "customer progress", "customer release"] as const) {
  test(`${scenario} protects source economics during edits and posts unchanged with metadata`, enabled, async () => fixture(async f => {
    let id: string;
    const customer = scenario.startsWith("customer");
    if (scenario === "vendor release") id = await vendorRelease(f);
    else if (scenario === "vendor application") id = await vendorBill(f);
    else {
      id = await customerProgress(f);
      if (scenario === "customer release") {
        await post(f, id, "customer_invoice");
        id = (await withOrgTransaction(f.org.orgId, () => releaseRetainage(f.org.orgId, f.actor, f.project, f.org.date, "50"))).invoiceId;
      }
    }
    await db.execute(sql`insert into custom_field_defs(org_id,target_table,key,label,field_type)
      values(${f.org.orgId},'document_lines','source_note','Source note','text')`);
    await db.execute(sql`update document_lines
      set custom='{"source_note":"Frozen scope"}'::jsonb,
          base_unit='source-unit', created_at='2026-01-02T03:04:05Z', updated_at='2026-01-03T04:05:06Z'
      where org_id=${f.org.orgId} and document_id=${id}`);
    const original = await lines(f, id);
    const originalSnapshot = (await snapshot(f, id))!.lines;
    const changed = scenario.endsWith("release") ? original.map(l => ({ ...l, amount: "150", unitPrice: "150" })) : original.filter(l => !String(l.amount).startsWith("-"));
    await refuseEdit(f, id, { lines: changed });
    await refuseEdit(f, id, { partyId: randomUUID() });
    await refuseEdit(f, id, { documentDate: "2026-01-01" });
    await refuseEdit(f, id, { lines: original.map(l => ({ ...l, accountId: f.org.accounts.bank })) });
    await refuseEdit(f, id, { lines: original.map(l => ({ ...l, description: "Changed source description" })) });
    await refuseEdit(f, id, { lines: original.map(l => ({ ...l, custom: { source_note: "Changed scope" } })) });
    if (original.length > 1) await refuseEdit(f, id, { lines: [...original].reverse() });
    // Source-only fields do not belong to the editor payload. Both forms of a
    // header save must leave the complete original rows, including IDs,
    // billability, custom values, provenance, and timestamps, untouched.
    await edit(f, id, { memo: "Header only" });
    assert.deepEqual((await snapshot(f, id))!.lines, originalSnapshot);
    await edit(f, id, { lines: original, memo: "Memo permitted", referenceNumber: "SOURCE-REF", dueDate: "2027-01-31" });
    assert.deepEqual((await snapshot(f, id))!.lines, originalSnapshot);
    const editedHeader = (await db.execute<{ memo: string; reference_number: string; due_date: string }>(sql`
      select memo,reference_number,due_date::text from documents where org_id=${f.org.orgId} and id=${id}
    `)).rows[0]!;
    assert.deepEqual(editedHeader, { memo: "Memo permitted", reference_number: "SOURCE-REF", due_date: "2027-01-31" });
    await post(f, id, customer ? "customer_invoice" : "vendor_bill");
    const doc = (await db.execute<{ status: string; memo: string; total: string }>(sql`select status,memo,total from documents where org_id=${f.org.orgId} and id=${id}`)).rows[0]!;
    assert.equal(doc.status, "posted"); assert.equal(doc.memo, "Memo permitted");
    assert.equal(doc.total, scenario === "vendor release" ? "100.0000" : scenario === "customer release" ? "50.0000" : "450.0000");
    const posted = (await db.execute<{ account_id: string; amount: string }>(sql`
      select l.account_id, sum(l.amount)::text as amount from journal_lines l
        join documents d on d.org_id=l.org_id and d.posted_entry_id=l.entry_id
      where d.org_id=${f.org.orgId} and d.id=${id} group by l.account_id
    `)).rows;
    const heldAccount = customer ? f.org.accounts.taxInput : f.org.accounts.invAsset;
    assert.equal(cmp(posted.find(l => l.account_id === heldAccount)!.amount, scenario === "vendor release" ? "100" : scenario === "customer release" ? "-50" : customer ? "50" : "-50"), 0);
    const openItem = customer ? f.org.accounts.ar : f.org.accounts.ap;
    assert.equal(cmp(posted.find(l => l.account_id === openItem)!.amount, customer ? doc.total : neg(doc.total)), 0);
  }));
}

for (const scenario of ["vendor release", "vendor application", "customer progress", "customer release"] as const) {
  test(`${scenario} rejects already-corrupted legacy drafts before posting writes`, enabled, async () => fixture(async f => {
    let id: string;
    const customer = scenario.startsWith("customer");
    if (scenario === "vendor release") id = await vendorRelease(f);
    else if (scenario === "vendor application") id = await vendorBill(f);
    else {
      id = await customerProgress(f);
      if (scenario === "customer release") {
        await post(f, id, "customer_invoice");
        id = (await withOrgTransaction(f.org.orgId, () => releaseRetainage(f.org.orgId, f.actor, f.project, f.org.date, "50"))).invoiceId;
      }
    }
    if (scenario.endsWith("release")) {
      await db.execute(sql`update document_lines set amount=150,unit_price=150 where org_id=${f.org.orgId} and document_id=${id}`);
      await db.execute(sql`update documents set total=150,subtotal=150 where org_id=${f.org.orgId} and id=${id}`);
    } else {
      await db.execute(sql`delete from document_lines where org_id=${f.org.orgId} and document_id=${id} and amount<0`);
      await db.execute(sql`update documents set total=500,subtotal=500 where org_id=${f.org.orgId} and id=${id}`);
    }
    await refusePost(f, id, customer ? "customer_invoice" : "vendor_bill");
  }));
}

test("retainage configuration change fails closed without remapping the generated release", enabled, async () => fixture(async f => {
  const id = await vendorRelease(f);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts,retainagePayable}',to_jsonb(${f.org.accounts.cogs}::text)) where id=${f.org.orgId}`);
  await refusePost(f, id);
}));

test("zero-retainage customer progress remains postable and custom markers cannot associate an ordinary bill", enabled, async () => fixture(async f => {
  const id = await customerProgress(f, "0");
  await post(f, id, "customer_invoice");
  const ordinary = randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,status,subsidiary_id,subtotal,total,custom)
    values(${ordinary},${f.org.orgId},'vendor_bill',${ordinary},${f.org.vendorId},${f.org.date},'CAD','draft',${f.org.subsidiaryId},10,10,'{"vendorPayApplicationId":"spoof","kind":"retainage_release"}')`);
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,amount) values(${f.org.orgId},${ordinary},1,${f.org.accounts.cogs},10)`);
  await edit(f, ordinary, { lines: [{ accountId: f.org.accounts.cogs, description: "Ordinary editable line", amount: "20", quantity: "1", unitPrice: "20" }] });
  const ordinaryLines = await lines(f, ordinary);
  assert.equal(ordinaryLines[0]!.description, "Ordinary editable line");
  assert.equal(cmp(ordinaryLines[0]!.amount, "20"), 0);
  await post(f, ordinary);
  // A real foreign reservation cannot scope an unrelated organization's edit.
  const linked = await vendorRelease(f);
  assert.equal(await assertGeneratedBillingEdit(db, randomUUID(), linked, { total: "999" }, null), false);
}));

test("full retainage and multiple gross lines preserve exact source allocation", enabled, async () => fixture(async f => {
  const first = randomUUID(), second = randomUUID();
  await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,sort_order,income_account_id)
    values(${first},${f.org.orgId},${f.project},'First','1000',1,${f.org.accounts.revenue}),
          (${second},${f.org.orgId},${f.project},'Second','1000',2,${f.org.accounts.recognized})`);
  const app = await withOrgTransaction(f.org.orgId, () => createPayApplication(f.org.orgId, f.actor, f.project, f.org.date, "100"));
  await withOrgTransaction(f.org.orgId, () => submitPayApplication(f.org.orgId, f.actor, app.id, [
    { sovLineId: first, thisPeriodCompleted: "200", materialsStored: "0" },
    { sovLineId: second, thisPeriodCompleted: "300", materialsStored: "0" },
  ]));
  await withOrgTransaction(f.org.orgId, () => approvePayApplication(f.org.orgId, f.approver, app.id));
  const id = (await withOrgTransaction(f.org.orgId, () => generatePayApplicationInvoice(f.org.orgId, f.actor, app.id))).invoiceId;
  const original = await lines(f, id);
  assert.equal(original.length, 3);
  await refuseEdit(f, id, { lines: original.map((l, i) => ({ ...l, amount: i === 0 ? "201" : i === 1 ? "299" : l.amount })) });
  await edit(f, id, { lines: original, memo: "Fully retained" });
  await post(f, id, "customer_invoice");
  assert.equal((await db.execute<{ total: string }>(sql`select total from documents where org_id=${f.org.orgId} and id=${id}`)).rows[0]!.total, "0.0000");
}));

test("explicit capitalization accounts remain valid on generated vendor bills", enabled, async () => fixture(async f => {
  await db.execute(sql`update subcontract_sov_lines set expense_account_id=${f.org.accounts.taxInput} where org_id=${f.org.orgId} and id=${f.sov}`);
  const id = await vendorBill(f);
  await post(f, id);
  assert.equal((await db.execute<{ amount: string }>(sql`select l.amount from journal_lines l join documents d on d.org_id=l.org_id and d.posted_entry_id=l.entry_id
    where d.org_id=${f.org.orgId} and d.id=${id} and l.account_id=${f.org.accounts.taxInput}`)).rows[0]!.amount, "500.0000");
}));

test("legacy equal-total gross redistribution is rejected from frozen source amounts", enabled, async () => fixture(async f => {
  const id = await customerProgress(f);
  await db.execute(sql`update document_lines set amount=499,unit_price=499 where org_id=${f.org.orgId} and document_id=${id} and amount>0`);
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,amount,project_id)
    values(${f.org.orgId},${id},3,${f.org.accounts.revenue},1,${f.project})`);
  await refusePost(f, id, "customer_invoice");
}));
