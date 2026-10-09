import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { createDocument, applyDocumentEdit } from "../ledger/document-write.ts";
import { loadDocument, loadDocumentEditCurrent } from "../ledger/document-service.ts";
import type { DocumentEditInput } from "../ledger/document-input.ts";
import { deleteDocument } from "../ledger/document-delete.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";
import { assertWithholdingDepositCurrent, assertWithholdingDepositEdit, createWithholdingDeposit } from "./deposits.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function fixture(org: ScratchOrg) {
  const actor = await createScratchUser(org.orgId, "Withholding accountant", "admin");
  const role = randomUUID(), authority = randomUUID(), enrollment = randomUUID();
  // The shared ISO registry may already contain USD from another scratch organization.
  await db.execute(sql`insert into currencies(code,name,minor_units) values('USD','US Dollar',2) on conflict(code) do nothing`);
  await db.execute(sql`update orgs set base_currency='USD',country='US',settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"contractorWithholding":true,"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
  await db.execute(sql`update subsidiaries set country='US',base_currency='USD' where org_id=${org.orgId} and id=${org.subsidiaryId}`);
  await db.execute(sql`insert into app_roles(id,org_id,key,name,permissions) values(${role},${org.orgId},'withholding-accountant','Withholding accountant','["ap.pay","documents.manage","admin.setup.manage"]'::jsonb)`);
  await db.execute(sql`insert into role_assignments(org_id,user_id,role_id) values(${org.orgId},${actor},${role})`);
  await db.execute(sql`insert into parties(id,org_id,kind,display_name) values(${authority},${org.orgId},'company','Internal Revenue Service')`);
  await db.execute(sql`insert into vendor_roles(org_id,party_id,backup_withholding) values(${org.orgId},${org.vendorId},true),(${org.orgId},${authority},false)`);
  const policy = {
    calendar: { from: "2026-01-01", to: "2027-12-31", closedDates: ["2026-04-16", "2027-04-16"], sourceReference: "IRS confirmed deposit calendar" },
    lookback: { taxYear: 2024, totalTax: "10000", sourceReference: "Filed 2024 Form 945" },
  };
  await db.execute(sql`insert into withholding_enrollments(id,org_id,subsidiary_id,scheme_code,contractor_reference,liability_account_id,authority_party_id,remittance_schedule_code,remittance_policy,effective_from,created_by,updated_by)
    values(${enrollment},${org.orgId},${org.subsidiaryId},'US_BACKUP_WITHHOLDING','12-3456789',${org.accounts.withholding},${authority},'US_MONTHLY',${JSON.stringify(policy)}::jsonb,'2018-01-01',${actor},${actor})`);
  const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
  const post = async (id: string, kind: string) => {
    assert.equal((await submitAndReleaseIfUngated(kind, id, actor)).autoApproved, true);
    return postDocument(id, deps, { audit: { actorId: actor, source: "ui" } });
  };
  const body = { partyId: org.vendorId, documentDate: org.date, lines: [{ accountId: org.accounts.cogs, amount: "1000" }] };
  const bill = await createDocument({ orgId: org.orgId, userId: actor, kind: "vendor_bill", key: randomUUID(), body, requestBody: body, subsidiaryId: org.subsidiaryId });
  const billEntry = await post(bill.id, "vendor_bill");
  const openLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${billEntry} and account_id=${org.accounts.ap}`)).rows[0]!.id;
  const payment = await createPaymentDocument({ orgId: org.orgId, createdBy: actor, kind: "vendor_payment", partyId: org.vendorId,
    subsidiaryId: org.subsidiaryId, bankAccountId: org.accounts.bank, documentDate: org.date, currency: "USD", allowedSubsidiaryIds: null });
  await updateDraftPayment(payment.id, { allocations: [{ openLineId: openLine, sourceTransactionAmount: "1000", targetTransactionAmount: "1000",
    settlementRate: "1", settlementRateSource: "same_currency", settlementRateReference: "Same transaction currency" }] }, actor, org.orgId, { allowedSubsidiaryIds: null });
  await post(payment.id, "vendor_payment");
  const deduction = (await db.execute<{ id: string; amount: string }>(sql`select id,deducted_amount::text as amount from withholding_deductions where org_id=${org.orgId} and payment_document_id=${payment.id} and status='posted'`)).rows;
  assert.equal(deduction.length, 1);
  assert.equal(deduction[0]!.amount, "240.0000");
  const prepare = (throughDate = org.date) => withOrgTransaction(org.orgId, () => createWithholdingDeposit(db, org.orgId, { enrollmentId: enrollment, throughDate }, actor));
  return { actor, role, authority, enrollment, paymentId: payment.id, deductionId: deduction[0]!.id, deps, post, prepare };
}

async function scenario(run: (org: ScratchOrg, f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => run(org, await fixture(org))); }
  finally { await dropScratchOrg(org.orgId); }
}

test("native deposit preparation snapshots one posted deduction and retries without duplicate bills or reservations", enabled, async () => scenario(async (org, f) => {
  const first = await f.prepare();
  assert.deepEqual(await f.prepare(), first);
  const loaded = (await loadDocument(first.documentId, org.orgId))!;
  assert.equal(loaded.doc.status, "draft");
  assert.equal(loaded.doc.party_id, f.authority);
  assert.equal(loaded.doc.subsidiary_id, org.subsidiaryId);
  assert.equal(loaded.doc.currency, "USD");
  assert.equal(loaded.doc.total, "240.0000");
  const source = (loaded.doc.custom as { withholdingDeposit: { deductionIds: string[]; dueDate: string; sourceFX: { rate: string; asOf: string; sameCurrencyPar: boolean } } }).withholdingDeposit;
  assert.deepEqual(source.deductionIds, [f.deductionId]);
  assert.equal(source.dueDate, "2026-08-17");
  assert.equal(source.sourceFX.rate, "1");
  assert.equal(source.sourceFX.asOf, org.date);
  assert.equal(source.sourceFX.sameCurrencyPar, true);
  assert.equal(loaded.lines.length, 1);
  assert.equal(loaded.lines[0]!.account_id, org.accounts.withholding);
  assert.equal(loaded.lines[0]!.amount, "240.0000");
  assert.equal(loaded.lines[0]!.withholding_treatment, "excluded");
  await withOrgTransaction(org.orgId, () => assertWithholdingDepositCurrent(db, org.orgId, first.documentId));
  await assert.rejects(() => f.prepare("2026-07-16"), /No unreserved posted deductions/);
  const counts = (await db.execute<{ bills: number; audits: number }>(sql`select
    (select count(*)::int from documents where org_id=${org.orgId} and custom ? 'withholdingDeposit') as bills,
    (select count(*)::int from audit_log where org_id=${org.orgId} and row_id=${first.documentId} and changes->>'reason'='authority_deposit_prepared') as audits`)).rows[0];
  assert.deepEqual(counts, { bills: 1, audits: 1 });
}));

test("native deposit edits preserve dates, authority, currency, source lines and captured FX while allowing notes", enabled, async () => scenario(async (org, f) => {
  const deposit = await f.prepare();
  const before = (await loadDocument(deposit.documentId, org.orgId))!;
  const edit = async (body: DocumentEditInput) => {
    const current = (await loadDocumentEditCurrent(deposit.documentId, org.orgId))!;
    await applyDocumentEdit(deposit.documentId, current, { ...body, expectedUpdatedAt: current.updatedAt }, { orgId: org.orgId, userId: f.actor, source: "ui", runFlows: false });
  };
  const nativeLines = before.lines.map(line => ({
    lineId: line.id as string, accountId: line.account_id as string, itemId: null,
    description: line.description as string, quantity: line.quantity as string,
    unit: null, unitPrice: line.unit_price as string, amount: line.amount as string,
    taxCodeId: null, taxGroupId: null, taxAmount: null, taxOverridden: false,
    withholdingTreatment: "excluded" as const, withholdingMaterialsCost: null,
    departmentId: null, projectId: null, locationId: null, classId: null,
    stockLocationId: null, extraDims: {}, custom: {}, distributionLocked: false,
  }));
  await edit({ memo: "July backup withholding deposit", custom: {}, documentDate: org.date,
    partyId: f.authority, subsidiaryId: org.subsidiaryId, dueDate: "2026-08-17", lines: nativeLines });
  assert.equal((await loadDocument(deposit.documentId, org.orgId))!.doc.memo, "July backup withholding deposit");
  for (const patch of [{ documentDate: "2026-07-16" }, { dueDate: "2026-08-18" }, { partyId: org.vendorId }, { currency: "CAD" },
    { lines: [{ accountId: org.accounts.withholding, amount: "241" }] }]) {
    await assert.rejects(() => edit(patch), /authority document retains/);
  }
  await assert.rejects(() => edit({ custom: { withholdingDeposit: null } }), /source evidence/);
  // Native editors expose no FX mutation; the reusable source guard also refuses it explicitly.
  await assert.rejects(() => assertWithholdingDepositEdit(db, org.orgId, deposit.documentId, null, { fxRate: "1.1" }), /captured exchange rate/);
  assert.equal(await assertWithholdingDepositEdit(db, org.orgId, deposit.documentId, null, { fxRate: "1.0000000000" }), true);
  for (const changed of [{ accountId: org.accounts.cogs }, { unitPrice: "241" }, { taxCodeId: randomUUID() }, { description: "Changed source line" }]) {
    const unchanged = (await loadDocument(deposit.documentId, org.orgId))!;
    await assert.rejects(() => edit({ memo: "Must roll back", lines: [{ ...nativeLines[0]!, ...changed }] }));
    assert.deepEqual(await loadDocument(deposit.documentId, org.orgId), unchanged);
  }
  const after = (await loadDocument(deposit.documentId, org.orgId))!;
  assert.deepEqual(after.doc.custom, before.doc.custom);
  assert.deepEqual(after.lines, before.lines);
  assert.equal(after.doc.total, before.doc.total);
  assert.equal(after.doc.fx_rate, before.doc.fx_rate);
  await f.post(deposit.documentId, "vendor_bill");
  assert.equal((await loadDocument(deposit.documentId, org.orgId))!.doc.status, "posted");
}));

test("native draft deletion releases the deposit reservation with an actor audit and allows replacement", enabled, async () => scenario(async (org, f) => {
  const first = await f.prepare();
  await deleteDocument(first.documentId, f.actor, org.orgId, { allowedSubsidiaryIds: null, reason: "Replace authority deposit draft" });
  assert.equal(await loadDocument(first.documentId, org.orgId), null);
  const releases = (await db.execute<{ actor_id: string; before: { reservedDeductionIds: string[] }; after: { reservedDeductionIds: string[] } }>(sql`
    select actor_id,changes->'before' as before,changes->'after' as after from audit_log
    where org_id=${org.orgId} and row_id=${first.documentId} and changes->>'reason'='authority_deposit_released'`)).rows;
  assert.deepEqual(releases, [{ actor_id: f.actor, before: { reservedDeductionIds: [f.deductionId] }, after: { reservedDeductionIds: [] } }]);
  const replacement = await f.prepare();
  assert.notEqual(replacement.documentId, first.documentId);
  assert.equal((await loadDocument(replacement.documentId, org.orgId))!.doc.total, "240.0000");
  assert.deepEqual(await f.prepare(), replacement);
}));

test("posting and governed void balance the authority bill, preserve deduction evidence and release only the voided reservation", enabled, async () => scenario(async (org, f) => {
  const first = await f.prepare();
  const entry = await f.post(first.documentId, "vendor_bill");
  const legs = (await db.execute<{ account_id: string; amount: string }>(sql`select account_id,amount::text from journal_lines where org_id=${org.orgId} and entry_id=${entry}`)).rows;
  assert.deepEqual(new Map(legs.map(row => [row.account_id, row.amount])), new Map([[org.accounts.withholding, "240.0000"], [org.accounts.ap, "-240.0000"]]));
  assert.deepEqual(await f.prepare(), first);
  await assert.rejects(() => f.prepare("2026-07-16"), /No unreserved posted deductions/);
  await assert.rejects(() => deleteDocument(first.documentId, f.actor, org.orgId, { allowedSubsidiaryIds: null }), /cannot be deleted/);
  const voided = await requestDocumentVoid({ documentId: first.documentId, orgId: org.orgId, actorId: f.actor, reason: "Replace authority deposit bill", reversalDate: org.date, allowedSubsidiaryIds: null });
  assert.equal(voided.status, "voided");
  assert.ok(voided.reversalEntryId);
  const reversal = (await db.execute<{ account_id: string; amount: string }>(sql`select account_id,amount::text from journal_lines where org_id=${org.orgId} and entry_id=${voided.reversalEntryId}`)).rows;
  assert.deepEqual(new Map(reversal.map(row => [row.account_id, row.amount])), new Map([[org.accounts.withholding, "-240.0000"], [org.accounts.ap, "240.0000"]]));
  assert.equal((await loadDocument(first.documentId, org.orgId))!.doc.status, "voided");
  const deduction = (await db.execute<{ status: string; amount: string }>(sql`select status,deducted_amount::text as amount from withholding_deductions where org_id=${org.orgId} and id=${f.deductionId}`)).rows[0];
  assert.deepEqual(deduction, { status: "posted", amount: "240.0000" });
  const replacement = await f.prepare();
  assert.notEqual(replacement.documentId, first.documentId);
  assert.equal((await loadDocument(replacement.documentId, org.orgId))!.doc.total, "240.0000");
}));

test("native source payment reversal preserves evidence and refuses a stale approved deposit before any journal writes", enabled, async () => scenario(async (org, f) => {
  const deposit = await f.prepare();
  assert.equal((await submitAndReleaseIfUngated("vendor_bill", deposit.documentId, f.actor)).autoApproved, true);
  const result = await requestDocumentVoid({ documentId: f.paymentId, orgId: org.orgId, actorId: f.actor, reason: "Reverse incorrectly paid contractor bill", reversalDate: org.date, allowedSubsidiaryIds: null });
  assert.equal(result.status, "voided");
  const deduction = (await db.execute<{ status: string; amount: string; voided_by: string }>(sql`select status,deducted_amount::text as amount,voided_by from withholding_deductions where org_id=${org.orgId} and id=${f.deductionId}`)).rows[0];
  assert.deepEqual(deduction, { status: "voided", amount: "240.0000", voided_by: f.actor });
  await assert.rejects(() => postDocument(deposit.documentId, f.deps, { audit: { actorId: f.actor, source: "ui" } }), /no longer matches its posted source deductions/);
  const state = (await db.execute<{ status: string; posted_entry_id: string | null; entries: number }>(sql`select status,posted_entry_id,
    (select count(*)::int from journal_entries where org_id=d.org_id and source_document_id=d.id) as entries
    from documents d where org_id=${org.orgId} and id=${deposit.documentId}`)).rows[0];
  assert.deepEqual(state, { status: "approved", posted_entry_id: null, entries: 0 });
  await requestDocumentVoid({ documentId: deposit.documentId, orgId: org.orgId, actorId: f.actor, reason: "Discard stale authority deposit bill", reversalDate: org.date, allowedSubsidiaryIds: null });
  await assert.rejects(() => f.prepare(), /No unreserved posted deductions/);
}));

test("deposit commands enforce live payment permission, legal-entity scope and the organization feature before creating evidence", enabled, async () => scenario(async (org, f) => {
  await db.execute(sql`update app_roles set permissions='["documents.manage"]'::jsonb where org_id=${org.orgId} and id=${f.role}`);
  await assert.rejects(() => f.prepare(), /missing permission: ap.pay/);
  await db.execute(sql`delete from role_assignments where org_id=${org.orgId} and user_id=${f.actor} and role_id<>${f.role}`);
  await db.execute(sql`update app_roles set permissions='["ap.pay","documents.manage"]'::jsonb,subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${org.orgId} and id=${f.role}`);
  await assert.rejects(() => f.prepare(), /withholding enrollment not found/);
  await db.execute(sql`delete from role_assignments where org_id=${org.orgId} and user_id=${f.actor} and role_id<>${f.role}`);
  await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and id=${f.role}`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,contractorWithholding}','false'::jsonb) where id=${org.orgId}`);
  await assert.rejects(() => f.prepare(), /Enable Contractor withholding/);
  assert.equal((await db.execute(sql`select id from documents where org_id=${org.orgId} and custom ? 'withholdingDeposit'`)).rows.length, 0);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,contractorWithholding}','true'::jsonb) where id=${org.orgId}`);
  const prepared = await f.prepare();
  assert.equal((await loadDocument(prepared.documentId, org.orgId))!.doc.total, "240.0000");
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,contractorWithholding}','false'::jsonb) where id=${org.orgId}`);
  await assert.rejects(() => f.post(prepared.documentId, "vendor_bill"), /Enable Contractor withholding/);
  assert.equal((await db.execute(sql`select id from journal_entries where org_id=${org.orgId} and source_document_id=${prepared.documentId}`)).rows.length, 0);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,contractorWithholding}','true'::jsonb) where id=${org.orgId}`);
  await postDocument(prepared.documentId, f.deps, { audit: { actorId: f.actor, source: 'ui' } });
}));
