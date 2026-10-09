import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { createDocument, applyDocumentEdit } from "./document-write.ts";
import { loadDocument, loadDocumentEditCurrent } from "./document-service.ts";
import { postDocument } from "./posting-document.ts";
import { createPaymentDocument, updateDraftPayment } from "../payments/payment-documents.ts";
import { storedPaymentWithholdings } from "../contractor-withholding/service.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test("native bills retain direct materials costs through edits and partial CIS payment saves", enabled, async () => {
  const org = await createScratchOrg();
  try { await withOrgContext(org.orgId, async () => {
    const actor = await createScratchUser(org.orgId, "Contractor accountant", "admin");
    await db.execute(sql`update orgs set base_currency='GBP', settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"contractorWithholding":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`update subsidiaries set country='GB',base_currency='GBP' where org_id=${org.orgId} and id=${org.subsidiaryId}`);
    const enrollment = randomUUID(), standing = randomUUID();
    await db.execute(sql`insert into withholding_enrollments(id,org_id,subsidiary_id,scheme_code,contractor_reference,liability_account_id,effective_from,created_by,updated_by)
      values(${enrollment},${org.orgId},${org.subsidiaryId},'GB_CIS','123PA00000000',${org.accounts.withholding},'2007-04-06',${actor},${actor})`);
    await db.execute(sql`insert into withholding_standings(id,org_id,party_id,scheme_code,band_code,verification_reference,valid_from,payee_reference,created_by,updated_by)
      values(${standing},${org.orgId},${org.vendorId},'GB_CIS','NET','V1234567890','2007-04-06','1234567890',${actor},${actor})`);
    const body = { partyId: org.vendorId, documentDate: org.date, lines: [
      { accountId: org.accounts.cogs, amount: "1000", withholdingTreatment: "labour" as const },
      { accountId: org.accounts.cogs, amount: "400", withholdingTreatment: "materials" as const, withholdingMaterialsCost: "300" },
    ] };
    const input = { orgId: org.orgId, userId: actor, kind: "vendor_bill", key: randomUUID(), body,
      subsidiaryId: org.subsidiaryId, requestBody: body };
    const created = await createDocument(input);
    assert.equal((await createDocument(input)).status, "replayed");
    const read = () => loadDocument(created.id, org.orgId);
    let loaded = (await read())!;
    assert.equal(loaded.lines[1]!.withholding_materials_cost, "300.0000");
    const edit = async (treatment: "labour" | "materials", cost?: string) => {
      const current = (await loadDocumentEditCurrent(created.id, org.orgId))!;
      const loaded = (await read())!;
      await applyDocumentEdit(created.id, current, { expectedUpdatedAt: current.updatedAt, lines: loaded.lines.map((line, index) => ({
        lineId: line.id as string, accountId: org.accounts.cogs, amount: index === 0 ? "1000" : "400",
        withholdingTreatment: index === 0 ? "labour" : treatment,
        ...(index === 1 && cost !== undefined ? { withholdingMaterialsCost: cost } : {}),
      })) }, { orgId: org.orgId, userId: actor, source: "ui", runFlows: false });
    };
    await edit("labour");
    assert.equal((await read())!.lines[1]!.withholding_materials_cost, "300.0000");
    await edit("materials");
    await assert.rejects(() => edit("materials", "401"), /no greater than the net line amount/);
    loaded = (await read())!;
    assert.equal(loaded.lines[1]!.withholding_treatment, "materials");
    assert.equal(loaded.lines[1]!.withholding_materials_cost, "300.0000");
    const audits = (await db.execute<{ after: { lines: { withholding_materials_cost: string | number | null }[] } }>(sql`
      select changes->'after' as after from audit_log where org_id=${org.orgId} and table_name='documents' and row_id=${created.id} and action='update' order by at
    `)).rows;
    assert.ok(audits.some(audit => audit.after.lines.some(line => /^300(?:\.0+)?$/.test(String(line.withholding_materials_cost)))));
    await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${created.id}`);
    const entry = await postDocument(created.id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    const openLine = (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${org.orgId} and entry_id=${entry} and account_id=${org.accounts.ap}`)).rows[0]!.id;
    const payment = await createPaymentDocument({ orgId: org.orgId, createdBy: actor, kind: "vendor_payment", partyId: org.vendorId,
      subsidiaryId: org.subsidiaryId, bankAccountId: org.accounts.bank, documentDate: org.date, currency: "GBP", allowedSubsidiaryIds: null });
    const save = (amount: string) => updateDraftPayment(payment.id, { allocations: [{ openLineId: openLine,
      sourceTransactionAmount: amount, targetTransactionAmount: amount, settlementRate: "1", settlementRateSource: "same_currency" as const,
      settlementRateReference: "Same transaction currency" }] }, actor, org.orgId, { allowedSubsidiaryIds: null });
    await save("700");
    let paymentRow = (await db.execute<{ total: string; custom: unknown }>(sql`select total::text,custom from documents where org_id=${org.orgId} and id=${payment.id}`)).rows[0]!;
    assert.equal(paymentRow.total, "590.0000");
    assert.equal(storedPaymentWithholdings(paymentRow.custom)[0]!.deducted, "110.0000");
    await save("1400");
    paymentRow = (await db.execute<{ total: string; custom: unknown }>(sql`select total::text,custom from documents where org_id=${org.orgId} and id=${payment.id}`)).rows[0]!;
    assert.equal(paymentRow.total, "1180.0000");
    assert.equal(storedPaymentWithholdings(paymentRow.custom)[0]!.deducted, "220.0000");
  }); } finally { await dropScratchOrg(org.orgId); }
});
