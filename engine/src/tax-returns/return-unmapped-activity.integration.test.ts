import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { computeTaxReturn, TaxReturnError } from "./return.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

// A state-return install maps only jurisdiction-matched codes, so a code with
// period activity can map to no box — and the return used to file
// short silently. The compute now refuses by name when the unmapped code
// belongs on THIS return (its jurisdiction, or the catalog's expected code
// for the form). Another jurisdiction's codes stay another return's
// business, so multi-jurisdiction orgs keep filing each return separately.

const DB = !!process.env.OPENBOOKS_DB_URL;

const FORM = "US_NY_ST100";

async function seedNyForm(orgId: string): Promise<string> {
  const nyId = randomUUID();
  await db.execute(sql`
    insert into tax_jurisdictions (id, org_id, code, name, country, region, level, tax_type)
    values (${nyId}, ${orgId}, 'US-NY', 'New York', 'US', 'NY', 'state', 'sales_use')`);
  await db.execute(sql`
    insert into tax_return_forms (id, org_id, code, name, submission_channel, jurisdiction_id, is_active)
    values (${randomUUID()}, ${orgId}, ${FORM}, 'NY ST-100 probe', 'portal_manual', ${nyId}, true)`);
  await db.execute(sql`
    insert into tax_report_lines
      (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
    values (${randomUUID()}, ${orgId}, ${FORM}, '1', 'Probe box', null, null, 1, 10)`);
  return nyId;
}

async function seedCode(
  orgId: string,
  code: string,
  jurisdictionId: string | null,
  country: string | null,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into tax_codes (id, org_id, code, name, country, jurisdiction_id, applies_to, is_active)
    values (${id}, ${orgId}, ${code}, ${code}, ${country}, ${jurisdictionId}, 'both', true)`);
  return id;
}

async function postTaxActivity(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  codeId: string,
): Promise<void> {
  const book = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${org.orgId} and is_primary limit 1`)).rows[0]!;
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entryId}, ${org.orgId}, ${book.id}, ${org.subsidiaryId}, ${`ACT-${entryId.slice(0, 8)}`},
            ${org.date}, ${org.periodId}, 'unmapped probe', 'draft', 'manual')`);
  await db.execute(sql`
    insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, tax_code_id)
    values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId},
            '20.0000', 'CAD', '20.0000', 1, null),
           (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.taxOutput}, ${org.subsidiaryId},
            '-20.0000', 'CAD', '-20.0000', 1, ${codeId})`);
  await db.execute(sql`
    update journal_entries set status = 'posted'
     where id = ${entryId} and org_id = ${org.orgId}`);
}

async function rejectsUnderstating(org: Awaited<ReturnType<typeof createScratchOrg>>, code: string): Promise<void> {
  await assert.rejects(
    computeTaxReturn(org.orgId, FORM, org.date, org.date),
    (e: unknown) => {
      assert.ok(e instanceof TaxReturnError);
      assert.match(e.message, /understates/);
      assert.ok(e.message.includes(code), e.message);
      return true;
    },
  );
}

test("an in-jurisdiction code with activity but no box refuses", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const nyId = await seedNyForm(org.orgId);
    const codeId = await seedCode(org.orgId, "US-NY-HAND", nyId, "US");
    await postTaxActivity(org, codeId);
    await rejectsUnderstating(org, "US-NY-HAND");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the catalog-expected code with activity but no jurisdiction refuses", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedNyForm(org.orgId);
    // US-NY-ST is the library's own code for US_NY_ST100: hand-made without
    // a jurisdiction, the install maps it nowhere — the defect's row.
    const codeId = await seedCode(org.orgId, "US-NY-ST", null, "US");
    await postTaxActivity(org, codeId);
    await rejectsUnderstating(org, "US-NY-ST");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("deactivating a code does not hide its posted in-period activity", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const nyId = await seedNyForm(org.orgId);
    const codeId = await seedCode(org.orgId, "US-NY-INACTIVE", nyId, "US");
    await postTaxActivity(org, codeId);
    await db.execute(sql`update tax_codes set is_active = false where org_id = ${org.orgId} and id = ${codeId}`);
    await rejectsUnderstating(org, "US-NY-INACTIVE");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a voided source document is not return-relevant unmapped activity", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const nyId = await seedNyForm(org.orgId);
    const codeId = await seedCode(org.orgId, "US-NY-VOIDED", nyId, "US");
    const documentId = randomUUID();
    const lineId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-VOIDED-NY',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date}, 'CAD', 1,
              '200.0000', '20.0000', '220.0000')`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '200.0000',
              '200.0000', '20.0000', ${codeId}, '1', '200.0000')`);
    await db.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, withholding_account_id, overridden)
      values (${org.orgId}, ${lineId}, ${codeId}, 1, '10', '200.0000', '20.0000',
              '20.0000', '0.0000', 'standard', false, false, 2, ${org.accounts.taxOutput},
              null, null, false)`);
    await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${documentId}`);
    await postDocument(documentId, { control: {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    } });
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const voidResult = await requestDocumentVoid({
      documentId,
      orgId: org.orgId,
      actorId,
      reason: "voided tax transaction probe",
      reversalDate: org.date,
      source: "api",
    });
    assert.equal(voidResult.status, "voided");

    const result = await computeTaxReturn(org.orgId, FORM, org.date, org.date);
    assert.equal(result.boxes.length, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("another jurisdiction's active code does not block this return", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await seedNyForm(org.orgId);
    const caId = randomUUID();
    await db.execute(sql`
      insert into tax_jurisdictions (id, org_id, code, name, country, region, level, tax_type)
      values (${caId}, ${org.orgId}, 'US-CA', 'California', 'US', 'CA', 'state', 'sales_use')`);
    const codeId = await seedCode(org.orgId, "US-CA-ST", caId, "US");
    await postTaxActivity(org, codeId);
    const result = await computeTaxReturn(org.orgId, FORM, org.date, org.date);
    assert.equal(result.boxes.length, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a mapped in-jurisdiction code computes without refusing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const nyId = await seedNyForm(org.orgId);
    const codeId = await seedCode(org.orgId, "US-NY-MAPPED", nyId, "US");
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values (${randomUUID()}, ${org.orgId}, ${FORM}, '2', 'Mapped box', ${codeId}, 'tax_amount', 1, 20)`);
    await postTaxActivity(org, codeId);
    const result = await computeTaxReturn(org.orgId, FORM, org.date, org.date);
    const values = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
    assert.equal(values.get("2"), "-20.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
