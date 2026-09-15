import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { postDocument } from "./posting.ts";
import { computeTaxReturn } from "./tax-return.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

// Live-Postgres regression: the first GST34 seed installed lines 103
// (GST/HST collected) and 106 (input tax credits) with basis 'tax_amount' —
// every tax line for the code, with no collected/paid split. A code that
// applies to both sales and purchases landed whole in BOTH boxes, so 106
// came out negated and net tax (line 109) doubled. The split fix corrected
// the library pack, but installed rows froze at the pre-split basis and
// kept filing the doubled return. Forward migration 0147 heals exactly
// those stale-installed rows to the corrected library bases.

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
): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const sales = SALES_KINDS.has(kind);
  const accountId = sales ? org.accounts.revenue : org.accounts.cogs;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, ${kind}, 'draft', ${number}, ${org.subsidiaryId},
              ${sales ? org.customerId : org.vendorId}, ${org.date}, ${org.date},
              'CAD', '1', ${amount}, ${taxAmount}, ${(Number(amount) + Number(taxAmount)).toFixed(4)})`);
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

test("a pre-split GST34 install files the true net tax after the 0147 heal", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // One code that applies to BOTH sides — the shape every provisioned pack code has.
    const codeId = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
      values (${codeId}, ${org.orgId}, 'GST-STD', 'Standard GST', 'both', 'standard',
              ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`);

    const control = { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank };
    const inv = await seedTaxedDocument(org, "customer_invoice", "INV-1", codeId, "200.0000", "20.0000");
    await postDocument(inv, { control });
    const bill = await seedTaxedDocument(org, "vendor_bill", "BILL-1", codeId, "150.0000", "15.0000");
    await postDocument(bill, { control });

    // The pre-split install shape: 103/106 on basis 'tax_amount' with the
    // same both-side code, exactly as the first seed wrote them.
    const formCode = "CA_GST34";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'GST/HST Return (GST34)', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence, formula)
      values
        (${randomUUID()}, ${org.orgId}, ${formCode}, '103', 'GST/HST collected or collectible', ${codeId}, 'tax_amount', -1, 20, null),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '104', 'Adjustments to be added to net tax', null, null, 1, 30, null),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '105', 'Total GST/HST and adjustments', null, null, 1, 40, '103 + 104'),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '106', 'Input tax credits (ITCs)', ${codeId}, 'tax_amount', 1, 50, null),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '107', 'Adjustments to be deducted from net tax', null, null, 1, 60, null),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '108', 'Total ITCs and adjustments', null, null, 1, 70, '106 + 107'),
        (${randomUUID()}, ${org.orgId}, ${formCode}, '109', 'Net tax', null, null, 1, 80, '105 - 108')`);

    // The stale install doubles net tax: both boxes sum the same net (-5),
    // so 103 reads 5, 106 reads -5, and 109 reads 10 instead of 5.
    const stale = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const staleValues = new Map(stale.boxes.map((box) => [box.lineCode, box.value]));
    assert.equal(staleValues.get("109"), "10.0000");

    // The heal: re-apply the corrected library bases to the stale rows.
    // Re-run to prove idempotence — the second pass must change nothing.
    const migration = readFileSync(
      "schema/migrations/generated/0147_gst34_box_basis_heal.sql", "utf8");
    for (let pass = 0; pass < 2; pass++) {
      const client = await pool.connect();
      try {
        await client.query(migration);
      } finally {
        client.release();
      }
    }
    const basis = await db.execute<{ line_code: string; basis: string }>(sql`
      select line_code, basis from tax_report_lines
       where org_id = ${org.orgId} and report_code = ${formCode} and line_code in ('103', '106')
       order by line_code`);
    assert.deepEqual(basis.rows, [
      { line_code: "103", basis: "tax_collected" },
      { line_code: "106", basis: "tax_paid" },
    ]);

    // Healed: collected and paid separate, net tax is the true 5.0000.
    const healed = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = new Map(healed.boxes.map((box) => [box.lineCode, box.value]));
    assert.equal(values.get("103"), "20.0000");
    assert.equal(values.get("106"), "15.0000");
    assert.equal(values.get("109"), "5.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
