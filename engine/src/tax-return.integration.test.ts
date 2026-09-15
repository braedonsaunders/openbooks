import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import { computeTaxReturn } from "./tax-return.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

// Live-Postgres regression: a taxable-base return box used to sum EVERY posted
// document line carrying the box's tax codes, regardless of document kind. A
// provisioned code applies to both sides, and the pack seeds it into both the
// sales-base and the purchases-base box, so a customer invoice and a vendor
// bill on the same code landed in BOTH boxes (VAT100 box 6 == box 7, GST34
// line 101 included purchases). Credit memos were also added rather than
// netted. The engine now sums only the document family the box's declared
// side designates and nets credit memos.

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

const SALES_KINDS = new Set(["customer_invoice", "customer_credit"]);

/** Seed one approved taxable document whose single line carries `taxCodeId` directly. */
async function seedTaxedDocument(
  org: Org,
  kind: "customer_invoice" | "customer_credit" | "vendor_bill" | "vendor_credit",
  number: string,
  taxCodeId: string,
  amount: string,
  taxAmount: string,
  tender: { currency?: string; fxRate?: string } = {},
): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const sales = SALES_KINDS.has(kind);
  const accountId = sales ? org.accounts.revenue : org.accounts.cogs;
  const currency = tender.currency ?? "CAD";
  const fxRate = tender.fxRate ?? "1";
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, ${kind}, 'draft', ${number}, ${org.subsidiaryId},
              ${sales ? org.customerId : org.vendorId}, ${org.date}, ${org.date},
              ${currency}, ${fxRate}, ${amount}, ${taxAmount}, ${(Number(amount) + Number(taxAmount)).toFixed(4)})`);
    await tx.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${accountId}, ${amount},
              ${amount}, ${taxAmount}, ${taxCodeId}, '1', ${amount})`);
    await tx.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, withholding_account_id, overridden)
      values (${org.orgId}, ${lineId}, ${taxCodeId}, 1, '10', ${amount}, ${taxAmount},
              ${taxAmount}, '0.0000', 'standard', false, false, 2,
              ${sales ? org.accounts.taxOutput : null}, ${sales ? null : org.accounts.taxInput},
              null, false)`);
    await tx.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  });
  return documentId;
}

test("a taxable-base box sums only its declared side and nets credit memos", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // One code that applies to BOTH sides — the shape every provisioned pack code has.
    const codeId = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
      values (${codeId}, ${org.orgId}, 'VAT-STD', 'Standard VAT', 'both', 'standard',
              ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`);

    const control = { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank };
    for (const [kind, number, amount, tax] of [
      ["customer_invoice", "INV-1", "200.0000", "20.0000"],
      ["customer_credit", "CN-1", "50.0000", "5.0000"],
      ["vendor_bill", "BILL-1", "150.0000", "15.0000"],
      ["vendor_credit", "VC-1", "30.0000", "3.0000"],
    ] as const) {
      const id = await seedTaxedDocument(org, kind, number, codeId, amount, tax);
      await postDocument(id, { control });
    }

    // The library VAT100: box 6 is the sales base, box 7 the purchases base —
    // the same code is mapped into both, exactly as installTaxReturnPack seeds it.
    const formCode = "GB_VAT100";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'VAT Return (VAT100)', 'efile_api', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values
        (${randomUUID()}, ${org.orgId}, ${formCode}, '1', 'VAT due on sales', ${codeId}, 'tax_collected', -1, 10),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '4', 'VAT reclaimed on purchases', ${codeId}, 'tax_paid', 1, 40),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '6', 'Total value of sales excluding VAT', ${codeId}, 'taxable_base', 1, 60),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '7', 'Total value of purchases excluding VAT', ${codeId}, 'taxable_base', 1, 70)`);

    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
    // Sales base: 200 invoice − 50 credit note. Purchases base: 150 bill − 30 vendor credit.
    assert.equal(values.get("6"), "150.0000");
    assert.equal(values.get("7"), "120.0000");
    // The tax boxes were already side-aware and must be unchanged by the fix.
    assert.equal(values.get("1"), "15.0000");
    assert.equal(values.get("4"), "12.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a tax journal in a secondary book does not leak into the return", { skip: !DB }, async () => {
  // Live-Postgres regression: the journal-backed boxes (tax_collected /
  // tax_paid / tax_amount) summed EVERY book, so a tax journal in a secondary
  // book leaked into the return while the filing gate only fences the primary
  // book. The return now reads the primary book, like every sibling engine.
  const org = await createScratchOrg();
  try {
    const codeId = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
      values (${codeId}, ${org.orgId}, 'TAX-SEC', 'Secondary-book probe', 'both', 'standard',
              ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`);

    const control = { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank };
    await postDocument(
      await seedTaxedDocument(org, "customer_invoice", "INV-BOOK", codeId, "200.0000", "20.0000"),
      { control },
    );

    // A balanced tax journal posted to a SECONDARY book: a ghost liability
    // the primary-book filing fence never covers.
    const book2 = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${book2}, ${org.orgId}, 'SEC', 'Secondary', false, true, true)`);
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${entryId}, ${org.orgId}, ${book2}, ${org.subsidiaryId}, 'SEC-1',
              ${org.date}, ${org.periodId}, 'secondary-book tax', 'draft', 'manual')`);
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

    const formCode = "BOOK-SCOPE";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'Book scope probe', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values
        (${randomUUID()}, ${org.orgId}, ${formCode}, '1', 'Tax collected', ${codeId}, 'tax_collected', -1, 10),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '5', 'Tax amount', ${codeId}, 'tax_amount', 1, 20)`);

    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
    // Primary-book invoice only: 20 collected, ledger sign kept on tax_amount.
    // Before the fix the secondary journal doubled both (40.0000 / -40.0000).
    assert.equal(values.get("1"), "20.0000");
    assert.equal(values.get("5"), "-20.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a taxable-base box converts foreign-currency lines at the posted rate", { skip: !DB }, async () => {
  // Live-Postgres regression: the journal-backed boxes (tax_collected /
  // tax_paid / tax_amount) sum journal_lines.amount — the kernel's
  // txn→functional conversion — but the taxable-base box summed
  // document_lines.amount raw, i.e. in TRANSACTION currency. A USD 200
  // invoice at 1.35 in a CAD org reported a 200.0000 base next to a 27.0000
  // collected-tax box. The base must convert each line at the document's
  // posted header rate (documents.fx_rate), the same rate the kernel applied.
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values ('USD', 'US Dollar', 2)
      on conflict (code) do nothing`);
    const codeId = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
      values (${codeId}, ${org.orgId}, 'GST-FX', 'FX probe', 'both', 'standard',
              ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`);
    const control = { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank };
    await postDocument(
      await seedTaxedDocument(org, "customer_invoice", "INV-FX", codeId, "200.0000", "20.0000", {
        currency: "USD",
        fxRate: "1.3500000000",
      }),
      { control },
    );

    const formCode = "FX-BASE";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'FX base probe', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'BASE', 'Taxable base', ${codeId}, 'taxable_base', 1, 10),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'TAX', 'Tax collected', ${codeId}, 'tax_collected', -1, 20)`);

    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
    // 200 USD × 1.35 = 270 CAD of base; 20 USD × 1.35 = 27 CAD of tax.
    assert.equal(values.get("BASE"), "270.0000");
    assert.equal(values.get("TAX"), "27.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an undescribed box takes its side from a one-sided code", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const salesOnly = randomUUID();
    const purchasesOnly = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
      values
        (${salesOnly}, ${org.orgId}, 'OUT', 'Output only', 'sales', 'standard', ${org.accounts.taxOutput}, null, true),
        (${purchasesOnly}, ${org.orgId}, 'IN', 'Input only', 'purchases', 'standard', null, ${org.accounts.taxInput}, true)`);
    const control = { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank };
    await postDocument(await seedTaxedDocument(org, "customer_invoice", "INV-2", salesOnly, "80.0000", "8.0000"), { control });
    await postDocument(await seedTaxedDocument(org, "vendor_bill", "BILL-2", purchasesOnly, "40.0000", "4.0000"), { control });

    // A tenant-authored form the library knows nothing about.
    const formCode = "CUSTOM-RETURN";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'Custom return', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'SALES_BASE', 'Sales base', ${salesOnly}, 'taxable_base', 1, 1),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'PURCHASE_BASE', 'Purchase base', ${purchasesOnly}, 'taxable_base', 1, 2)`);

    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
    assert.equal(values.get("SALES_BASE"), "80.0000");
    assert.equal(values.get("PURCHASE_BASE"), "40.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("computeTaxReturn carries the form's registration number for the facsimile", { skip: !DB }, async () => {
  // Live-Postgres regression: the GST34 facsimile printed a hardcoded
  // '00000 0000 000000' business number even though the org's real CRA
  // registration sat in tax_registrations — computeTaxReturn dropped it, so
  // the printed government-form replica carried a fabricated identifier.
  const org = await createScratchOrg();
  try {
    const formCode = "REG-BN";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'BN probe return', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, '1', 'Probe box', null, null, 1, 10)`);
    const jurisdictionId = randomUUID();
    await db.execute(sql`
      insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type)
      values (${jurisdictionId}, ${org.orgId}, 'PROBE', 'Probe jurisdiction', 'CA', 'country', 'gst')`);
    await db.execute(sql`
      insert into tax_registrations
        (id, org_id, jurisdiction_id, registration_number, filing_frequency, return_form_code, is_active)
      values (${randomUUID()}, ${org.orgId}, ${jurisdictionId}, '123456789 RT0001', 'quarterly', ${formCode}, true)`);

    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    assert.equal(result.registrationNumber, "123456789 RT0001");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("computeTaxReturn reports a null registration number when the form is unregistered", { skip: !DB }, async () => {
  // The facsimile must print a blank identifier — never zeros — when the org
  // holds no registration for the form.
  const org = await createScratchOrg();
  try {
    const formCode = "REG-BN-ABSENT";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'Unregistered probe return', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, '1', 'Probe box', null, null, 1, 10)`);

    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    assert.equal(result.registrationNumber, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
