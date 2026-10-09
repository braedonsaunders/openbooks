import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { releaseVendorRetainageProvenance } from "../ledger/billing-provenance.ts";
import { applyDocumentEdit } from "../ledger/document-write.ts";
import { loadDocument, loadDocumentEditCurrent } from "../ledger/document-service.ts";
import { deleteDocument } from "../ledger/document-delete.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
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

async function fixture(run: (f: {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  actor: string;
  approver: string;
  subcontract: string;
}) => Promise<void>, beforePost?: (f: { org: Awaited<ReturnType<typeof createScratchOrg>>; actor: string; billId: string }) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Vendor retainage controller", "admin");
    const approver = await createScratchUser(org.orgId, "Vendor retainage approver", "admin");
    const project = randomUUID(), type = randomUUID();
    const vendor = randomUUID(), subcontract = randomUUID(), sov = randomUUID();
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"subcontracts":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text,'retainagePayable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    const profile = BUILTIN_PROJECT_TYPES.find((p) => p.key === "schedule_of_values")!;
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${type},${org.orgId},'vendor_retainage_delete_test','Vendor retainage delete test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch vendor retainage policy')`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'VRET','Vendor retainage job',${org.customerId},${type},'active')`);
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${org.orgId},'vendor','Vendor retainage vendor',true)`);
    await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,status) values(${subcontract},${org.orgId},${project},${vendor},'SC-VRET','Vendor retainage scope','CAD','5000','active')`);
    await db.execute(sql`insert into subcontract_sov_lines(id,org_id,subcontract_id,description,scheduled_value,expense_account_id,sort_order) values(${sov},${org.orgId},${subcontract},'Work','2000',${org.accounts.cogs},1)`);
    const app = await withOrgTransaction(org.orgId, () => createVendorPayApplication({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date }));
    await withOrgTransaction(org.orgId, () => updateVendorPayApplicationLines({ orgId: org.orgId, userId: actor, payApplicationId: app.id, expectedRevision: 1, lines: [{ sovLineId: sov, workCompletedThisPeriod: "1000", materialsStoredCurrent: "0" }] }));
    await withOrgTransaction(org.orgId, () => submitVendorPayApplication(org.orgId, actor, app.id));
    await withOrgTransaction(org.orgId, () => approveVendorPayApplication(org.orgId, approver, app.id));
    const generated = await withOrgTransaction(org.orgId, () => generateVendorPayApplicationBill(org.orgId, actor, app.id));
    await beforePost?.({ org, actor, billId: generated.vendorBillDocumentId });
    assert.equal((await submitAndReleaseIfUngated("vendor_bill", generated.vendorBillDocumentId, actor)).autoApproved, true);
    await postDocument(generated.vendorBillDocumentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }, { audit: { actorId: approver, source: "test" } });
    await run({ org, actor, approver, subcontract });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

test("draft vendor retainage release bill deletes with complete evidence and permits a corrected release", enabled, async () => fixture(async ({ org, actor, subcontract }) => {
  const first = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "100" }));
  // Database-side snapshot equality: the audit before-image must equal the
  // row's own to_jsonb exactly — every column, exact numeric, no conversion.
  const snapshot = (await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(vrr) as row from vendor_retainage_releases vrr where org_id=${org.orgId} and vendor_bill_document_id=${first.vendorBillDocumentId}`)).rows[0]!.row;
  await withOrgTransaction(org.orgId, () => deleteDocument(first.vendorBillDocumentId, actor, org.orgId, { reason: "Correct release amount", allowedSubsidiaryIds: null }));
  assert.equal((await db.execute(sql`select id from documents where org_id=${org.orgId} and id=${first.vendorBillDocumentId}`)).rows.length, 0);
  assert.equal((await db.execute(sql`select id from vendor_retainage_releases where org_id=${org.orgId} and id=${snapshot.id as string}`)).rows.length, 0);
  const evidence = (await db.execute<{ changes: { before: Record<string, unknown>; after: null; reason: string }; actor_id: string }>(sql`select changes,actor_id from audit_log where org_id=${org.orgId} and table_name='vendor_retainage_releases' and row_id=${snapshot.id as string} and action='billing_released'`)).rows;
  assert.equal(evidence.length, 1);
  const before = evidence[0]!.changes.before;
  assert.deepEqual(before, snapshot);
  assert.equal(before.vendor_bill_document_id, first.vendorBillDocumentId);
  assert.equal(evidence[0]!.changes.after, null);
  assert.equal(evidence[0]!.changes.reason, "Correct release amount");
  assert.equal(evidence[0]!.actor_id, actor);
  const released = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "100" }));
  assert.notEqual(released.vendorBillDocumentId, first.vendorBillDocumentId);
  await assert.rejects(
    withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "1" })),
    /exceeds posted retainage currently held/,
  );
}));

test("ordinary vendor application bills still regenerate after draft deletion", enabled, async () => fixture(async ({ org, actor, approver, subcontract }) => {
  const sov = (await db.execute<{ id: string }>(sql`select id from subcontract_sov_lines where org_id=${org.orgId} and subcontract_id=${subcontract}`)).rows[0]!.id;
  const laterPeriod = new Date(`${org.date}T00:00:00Z`);
  laterPeriod.setUTCDate(laterPeriod.getUTCDate() + 1);
  const app = await withOrgTransaction(org.orgId, () => createVendorPayApplication({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: laterPeriod.toISOString().slice(0, 10) }));
  await withOrgTransaction(org.orgId, () => updateVendorPayApplicationLines({ orgId: org.orgId, userId: actor, payApplicationId: app.id, expectedRevision: 1, lines: [{ sovLineId: sov, workCompletedThisPeriod: "500", materialsStoredCurrent: "0" }] }));
  await withOrgTransaction(org.orgId, () => submitVendorPayApplication(org.orgId, actor, app.id));
  await withOrgTransaction(org.orgId, () => approveVendorPayApplication(org.orgId, approver, app.id));
  const first = await withOrgTransaction(org.orgId, () => generateVendorPayApplicationBill(org.orgId, actor, app.id));
  await withOrgTransaction(org.orgId, () => deleteDocument(first.vendorBillDocumentId, actor, org.orgId, { reason: "Correct application bill", allowedSubsidiaryIds: null }));
  const reopened = (await db.execute<{ status: string; vendor_bill_document_id: string | null }>(sql`select status, vendor_bill_document_id from vendor_pay_applications where org_id=${org.orgId} and id=${app.id}`)).rows[0]!;
  assert.deepEqual(reopened, { status: "approved", vendor_bill_document_id: null });
  const replacement = await withOrgTransaction(org.orgId, () => generateVendorPayApplicationBill(org.orgId, actor, app.id));
  assert.notEqual(replacement.vendorBillDocumentId, first.vendorBillDocumentId);
  assert.equal(replacement.netDue, first.netDue);
}));

test("posted vendor retainage release bills refuse direct reservation release and draft deletion", enabled, async () => fixture(async ({ org, actor, approver, subcontract }) => {
  const first = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "100" }));
  assert.equal((await submitAndReleaseIfUngated("vendor_bill", first.vendorBillDocumentId, actor)).autoApproved, true);
  await postDocument(first.vendorBillDocumentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }, { audit: { actorId: approver, source: "test" } });
  assert.equal((await db.execute<{ status: string }>(sql`select status from documents where org_id=${org.orgId} and id=${first.vendorBillDocumentId}`)).rows[0]!.status, "posted");
  await assert.rejects(
    withOrgTransaction(org.orgId, () => releaseVendorRetainageProvenance(db, org.orgId, first.vendorBillDocumentId, { actorId: actor, reason: "Posted attempt" })),
    /only be released for a draft vendor bill/,
  );
  await assert.rejects(
    withOrgTransaction(org.orgId, () => deleteDocument(first.vendorBillDocumentId, actor, org.orgId, { reason: "Posted attempt", allowedSubsidiaryIds: null })),
    /cannot be deleted/,
  );
  assert.equal((await db.execute(sql`select id from vendor_retainage_releases where org_id=${org.orgId} and vendor_bill_document_id=${first.vendorBillDocumentId}`)).rows.length, 1);
  assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='vendor_retainage_releases' and action='billing_released'`)).rows.length, 0);
}));

test("voided vendor retainage release bills preserve release provenance and exclude voided capacity", enabled, async () => fixture(async ({ org, actor, approver, subcontract }) => {
  const first = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "100" }));
  assert.equal((await submitAndReleaseIfUngated("vendor_bill", first.vendorBillDocumentId, actor)).autoApproved, true);
  await postDocument(first.vendorBillDocumentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }, { audit: { actorId: approver, source: "test" } });
  const result = await requestDocumentVoid({ orgId: org.orgId, actorId: actor, documentId: first.vendorBillDocumentId, reason: "Correct retainage request", reversalDate: org.date });
  assert.equal(result.status, "voided");
  assert.equal((await db.execute(sql`select status from documents where org_id=${org.orgId} and id=${first.vendorBillDocumentId}`)).rows[0]!.status, "voided");
  assert.equal((await db.execute(sql`select id from vendor_retainage_releases where org_id=${org.orgId} and vendor_bill_document_id=${first.vendorBillDocumentId}`)).rows.length, 1);
  assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='vendor_retainage_releases' and action='billing_released'`)).rows.length, 0);
  const replacement = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "100" }));
  assert.notEqual(replacement.vendorBillDocumentId, first.vendorBillDocumentId);
}));

test("vendor retainage release audit rolls back with the delete transaction", enabled, async () => fixture(async ({ org, actor, subcontract }) => {
  const first = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "100" }));
  const foreignOrgId = randomUUID();
  await assert.rejects(
    withOrgTransaction(foreignOrgId, () => releaseVendorRetainageProvenance(db, foreignOrgId, first.vendorBillDocumentId, { actorId: actor, reason: "Foreign attempt" })),
    /only be released for a draft vendor bill/,
  );
  await assert.rejects(withOrgTransaction(org.orgId, async () => {
    await releaseVendorRetainageProvenance(db, org.orgId, first.vendorBillDocumentId, { actorId: actor, reason: "Rollback proof" });
    throw new Error("rollback proof");
  }), /rollback proof/);
  // An invalid audit actor forces a database error in the audit INSERT.
  // The full delete command must leave both the reservation and bill intact.
  await assert.rejects(withOrgTransaction(org.orgId, () =>
    deleteDocument(first.vendorBillDocumentId, "not-a-uuid", org.orgId, { reason: "Corrupt audit", allowedSubsidiaryIds: null }),
  ), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /insert into audit_log/);
    assert.equal((error.cause as { code?: string })?.code, "22P02");
    return true;
  });
  assert.equal((await db.execute(sql`select id from vendor_retainage_releases where org_id=${org.orgId} and vendor_bill_document_id=${first.vendorBillDocumentId}`)).rows.length, 1);
  assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='vendor_retainage_releases' and action='billing_released'`)).rows.length, 0);
  assert.equal((await db.execute<{ status: string }>(sql`select status from documents where org_id=${org.orgId} and id=${first.vendorBillDocumentId}`)).rows[0]!.status, "draft");
  await withOrgTransaction(org.orgId, () => deleteDocument(first.vendorBillDocumentId, actor, org.orgId, { reason: "Correct release amount", allowedSubsidiaryIds: null }));
  assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='vendor_retainage_releases' and action='billing_released'`)).rows.length, 1);
}));


test("generated subcontract bills keep line identities while auditing direct-cost edits and release source reservations", enabled, async () => {
  let sourceBill = "";
  await fixture(async ({ org, actor, subcontract }) => {
    const first = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor,
      subcontractId: subcontract, periodEnd: org.date, amount: "40" }));
    const last = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor,
      subcontractId: subcontract, periodEnd: org.date, amount: "60" }));
    const reservations = (await db.execute<{ sources: unknown }>(sql`
      select a.changes->'after'->'sources' as sources from vendor_retainage_releases r
        join audit_log a on a.org_id=r.org_id and a.table_name='vendor_retainage_releases' and a.row_id=r.id and a.action='insert'
       where r.org_id=${org.orgId} and r.vendor_bill_document_id in (${first.vendorBillDocumentId},${last.vendorBillDocumentId}) order by a.at,a.id
    `)).rows.map(row => row.sources);
    const nativeSources = (await db.execute<{ sources: unknown }>(sql`
      select r.source_bill_allocations as sources from vendor_retainage_releases r
       where r.org_id=${org.orgId} and r.vendor_bill_document_id in (${first.vendorBillDocumentId},${last.vendorBillDocumentId}) order by r.created_at,r.id
    `)).rows.map(row => row.sources);
    assert.deepEqual(nativeSources, reservations);
    await assert.rejects(() => db.execute(sql`update vendor_retainage_releases set source_bill_allocations='[]'::jsonb
      where org_id=${org.orgId} and vendor_bill_document_id=${first.vendorBillDocumentId}`), (error: unknown) => String((error as { cause?: unknown }).cause ?? error).includes('Retainage source allocations are immutable'));
    assert.deepEqual(reservations, [
      [{ documentId: sourceBill, held: "100.0000", previousAmount: "0.0000", amount: "40.0000" }],
      [{ documentId: sourceBill, held: "100.0000", previousAmount: "40.0000", amount: "60.0000" }],
    ]);
  }, async ({ org, actor, billId }) => {
    sourceBill = billId;
    await withOrgTransaction(org.orgId, async () => {
      const before = (await loadDocument(billId, org.orgId))!;
      const current = (await loadDocumentEditCurrent(billId, org.orgId))!;
      const sourceRows = (await db.execute<{ row: Record<string, unknown> }>(sql`
        select to_jsonb(l) as row from document_lines l where org_id=${org.orgId} and document_id=${billId} order by line_number
      `)).rows.map(line => line.row);
      assert.ok(before.lines.every(line => line.party_id === before.doc.party_id));
      // Match the native drawer payload: it retains stable identity and all
      // visible financial fields, while the line party remains source-owned.
      const lines = before.lines.map((line, index) => ({
        lineId: line.id as string, accountId: line.account_id as string, amount: String(line.amount), description: line.description as string,
        quantity: String(line.quantity), unitPrice: String(line.unit_price), projectId: line.project_id as string,
        itemId: line.item_id as string | null, unit: line.unit as string | null,
        taxCodeId: line.tax_code_id as string | null, taxGroupId: line.tax_group_id as string | null,
        taxOverridden: line.tax_overridden === true, departmentId: line.department_id as string | null,
        locationId: line.location_id as string | null, classId: line.class_id as string | null,
        stockLocationId: line.stock_location_id as string | null,
        extraDims: line.extra_dims as Record<string, string | null>, custom: line.custom as Record<string, unknown>,
        withholdingTreatment: index === 0 ? "materials" as const : "excluded" as const, withholdingMaterialsCost: index === 0 ? "600" : null,
      }));
      const edit = (submitted: typeof lines) => applyDocumentEdit(billId, current,
        { expectedUpdatedAt: current.updatedAt, lines: submitted }, { orgId: org.orgId, userId: actor, source: "ui", runFlows: false });
      await assert.rejects(() => edit(lines.map(line => ({ ...line, partyId: null }))), /source billing workflow/);
      await assert.rejects(() => edit(lines.map((line, index) => index === 0 ? { ...line, amount: "1001", unitPrice: "1001" } : line)), /source billing workflow/);
      await assert.rejects(() => edit(lines.map(line => ({ ...line, description: "Changed scope" }))), /source billing workflow/);
      await edit(lines);
      const after = (await loadDocument(billId, org.orgId))!;
      assert.deepEqual(after.lines.map(line => line.id), before.lines.map(line => line.id));
      assert.deepEqual(after.lines.map(line => line.party_id), before.lines.map(line => line.party_id));
      assert.equal(after.lines[0]!.withholding_materials_cost, "600.0000");
      assert.equal(after.lines[0]!.withholding_treatment, "materials");
      const editedRows = (await db.execute<{ row: Record<string, unknown> }>(sql`
        select to_jsonb(l) as row from document_lines l where org_id=${org.orgId} and document_id=${billId} order by line_number
      `)).rows.map(line => line.row);
      const immutableFields = (row: Record<string, unknown>) => {
        const { withholding_treatment, withholding_materials_cost, updated_by, updated_at, ...immutable } = row;
        return immutable;
      };
      assert.deepEqual(editedRows.map(immutableFields), sourceRows.map(immutableFields));
      const audited = (await db.execute<{ updated: boolean }>(sql`
        select exists(select 1 from audit_log a where a.org_id=${org.orgId} and a.table_name='documents' and a.row_id=${billId}
          and a.action='update' and a.actor_id=${actor} and (a.changes->'after'->'lines'->0->>'withholding_materials_cost')::numeric=600) as updated
      `)).rows[0]!;
      assert.equal(audited.updated, true);
    });
  });
});
