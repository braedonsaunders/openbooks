import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import { computeLineTaxes, type TaxComponentConfig } from "./tax.ts";
import { computeTaxReturn } from "./tax-return.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("component tax evidence posts exact recoverability, withholding, and reverse charge", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const codeIds = { standard: randomUUID(), withholding: randomUUID(), reverse: randomUUID() };
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, calculation_type, collected_account_id, paid_account_id,
         withholding_account_id, recoverable_percent, is_active)
      values
        (${codeIds.standard}, ${org.orgId}, 'STD', 'Standard', 'standard', ${org.accounts.taxOutput}, ${org.accounts.taxInput}, null, '50', true),
        (${codeIds.withholding}, ${org.orgId}, 'WHT', 'Withholding', 'withholding', null, null, ${org.accounts.withholding}, '100', true),
        (${codeIds.reverse}, ${org.orgId}, 'RC', 'Reverse charge', 'reverse_charge', ${org.accounts.taxOutput}, ${org.accounts.taxInput}, null, '80', true)`);
    const configs: TaxComponentConfig[] = [
      { taxCodeId: codeIds.standard, sequence: 1, ratePercent: "10", recoverablePercent: "50", calculationType: "standard", collectedAccountId: org.accounts.taxOutput, paidAccountId: org.accounts.taxInput },
      { taxCodeId: codeIds.withholding, sequence: 2, ratePercent: "3", recoverablePercent: "100", calculationType: "withholding", withholdingAccountId: org.accounts.withholding },
      { taxCodeId: codeIds.reverse, sequence: 3, ratePercent: "5", recoverablePercent: "80", calculationType: "reverse_charge", collectedAccountId: org.accounts.taxOutput, paidAccountId: org.accounts.taxInput },
    ];
    const calculated = computeLineTaxes("100", configs);
    assert.equal(calculated.taxTotal, "7.0000");

    const groupId = randomUUID();
    const documentId = randomUUID();
    const lineId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into tax_groups (id, org_id, code, name, is_active) values (${groupId}, ${org.orgId}, 'COMBINED', 'Combined taxes', true)`);
      for (const component of calculated.components) {
        await tx.execute(sql`insert into tax_group_members (tax_group_id, tax_code_id, sequence) values (${groupId}, ${component.taxCodeId}, ${component.sequence})`);
      }
      await tx.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, fx_rate, subtotal, tax_total, total)
        values (${documentId}, ${org.orgId}, 'vendor_bill', 'draft', 'TAX-CONTRACT', ${org.subsidiaryId},
                ${org.vendorId}, ${org.date}, 'CAD', '1', ${calculated.netAmount}, ${calculated.taxTotal}, ${calculated.total})`);
      await tx.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
           tax_amount, tax_group_id, quantity, unit_price)
        values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, ${calculated.netAmount},
                ${calculated.inputAmount}, ${calculated.taxTotal}, ${groupId}, '1', ${calculated.inputAmount})`);
      for (const component of calculated.components) {
        await tx.execute(sql`
          insert into document_line_tax_components
            (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
             tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
             price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
             paid_account_id, withholding_account_id, overridden)
          values (${org.orgId}, ${lineId}, ${component.taxCodeId}, ${component.sequence},
                  ${component.ratePercent}, ${component.taxableAmount}, ${component.taxAmount},
                  ${component.recoverableAmount}, ${component.nonrecoverableAmount},
                  ${component.calculationType}, ${component.priceIncludesTax},
                  ${component.compoundOnPrevious}, ${component.roundingScale},
                  ${component.collectedAccountId}, ${component.paidAccountId},
                  ${component.withholdingAccountId}, false)`);
      }
      await tx.execute(sql`
        update documents set status = 'approved' where id = ${documentId}
      `);
    });

    const entryId = await postDocument(documentId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    const gl = (await db.execute<{ account_id: string; amount: string }>(sql`
      select account_id, amount from journal_lines where entry_id = ${entryId} order by line_number
    `));
    assert.deepEqual(gl.rows, [
      { account_id: org.accounts.cogs, amount: "106.0000" },
      { account_id: org.accounts.taxInput, amount: "5.0000" },
      { account_id: org.accounts.withholding, amount: "-3.0000" },
      { account_id: org.accounts.taxInput, amount: "4.0000" },
      { account_id: org.accounts.taxOutput, amount: "-5.0000" },
      { account_id: org.accounts.ap, amount: "-107.0000" },
    ]);
    await assert.rejects(
      db.execute(sql`update document_line_tax_components set tax_amount = '99' where document_line_id = ${lineId}`),
      (error: unknown) => {
        const wrapped = error as { message?: string; cause?: { message?: string } };
        return /posted tax calculation evidence is immutable/.test(`${wrapped.message ?? ""} ${wrapped.cause?.message ?? ""}`);
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

type TaxFixtureComponent = {
  taxCodeId: string;
  sequence: number;
  taxAmount: string;
  recoverableAmount: string;
  nonrecoverableAmount: string;
  ratePercent: string;
  taxableAmount: string;
  calculationType?: "standard" | "withholding" | "reverse_charge";
  collectedAccountId: string | null;
  paidAccountId: string | null;
  withholdingAccountId?: string | null;
};

/** Seed one approved taxable document with immutable component evidence. */
async function seedTaxDocument(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  kind: "customer_invoice" | "vendor_bill",
  number: string,
  taxCodeId: string,
  component: TaxFixtureComponent,
  amount = "100.0000",
  approve = true,
): Promise<{ documentId: string; lineId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const accountId = kind === "customer_invoice" ? org.accounts.revenue : org.accounts.cogs;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, ${kind}, 'draft', ${number}, ${org.subsidiaryId},
              ${kind === "customer_invoice" ? org.customerId : org.vendorId}, ${org.date}, ${org.date},
              'CAD', '1', ${amount}, ${component.taxAmount}, ${Number(amount) + Number(component.taxAmount)})`);
    await tx.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${accountId}, ${amount},
              ${amount}, ${component.taxAmount}, ${taxCodeId}, '1', ${amount})`);
    await tx.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, withholding_account_id, overridden)
      values (${org.orgId}, ${lineId}, ${component.taxCodeId}, ${component.sequence},
              ${component.ratePercent}, ${component.taxableAmount}, ${component.taxAmount},
              ${component.recoverableAmount}, ${component.nonrecoverableAmount},
              ${component.calculationType ?? "standard"}, false, false, 2,
              ${component.collectedAccountId}, ${component.paidAccountId},
              ${component.withholdingAccountId ?? null}, false)`);
    if (approve) {
      await tx.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
    }
  });
  return { documentId, lineId };
}

test("taxable sales and purchases fail closed before journals or posting effects", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const taxCodeId = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id,
         paid_account_id, is_active)
      values (${taxCodeId}, ${org.orgId}, 'MISSING-CONTROL', 'Missing control', 'both',
              'standard', null, null, true)`);
    const component: TaxFixtureComponent = {
      taxCodeId,
      sequence: 1,
      ratePercent: "13.0000",
      taxableAmount: "100.0000",
      taxAmount: "13.0000",
      recoverableAmount: "13.0000",
      nonrecoverableAmount: "0.0000",
      collectedAccountId: null,
      paidAccountId: null,
    };
    const sale = await seedTaxDocument(org, "customer_invoice", "TAX-MISSING-SALE", taxCodeId, component);
    const purchase = await seedTaxDocument(org, "vendor_bill", "TAX-MISSING-PURCHASE", taxCodeId, component);
    const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
    await assert.rejects(postDocument(sale.documentId, deps), /collected tax .*no configured tax control account/);
    await assert.rejects(postDocument(purchase.documentId, deps), /paid tax .*no configured tax control account/);
    const counts = await db.execute<{ journals: string; effects: string; approved: string }>(sql`
      select
        (select count(*) from journal_entries where org_id = ${org.orgId} and source_document_id in (${sale.documentId}, ${purchase.documentId}))::text as journals,
        (select count(*) from posting_effects where org_id = ${org.orgId} and document_id in (${sale.documentId}, ${purchase.documentId}))::text as effects,
        (select count(*) from documents where org_id = ${org.orgId} and id in (${sale.documentId}, ${purchase.documentId}) and status = 'approved')::text as approved`);
    assert.deepEqual(counts.rows[0], { journals: "0", effects: "0", approved: "2" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("posted tax returns use immutable accounts and include grouped-line bases", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const taxA = randomUUID();
    const taxB = randomUUID();
    const groupId = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, applies_to, calculation_type, collected_account_id,
         paid_account_id, is_active)
      values
        (${taxA}, ${org.orgId}, 'IMM-A', 'Immutable A', 'both', 'standard', ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true),
        (${taxB}, ${org.orgId}, 'IMM-B', 'Immutable B', 'both', 'standard', null, null, true)`);
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(
           jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,taxCollected}', to_jsonb(${org.accounts.taxOutput}::text), true),
           '{controlAccounts,taxPaid}', to_jsonb(${org.accounts.taxInput}::text), true)
       where id = ${org.orgId}`);
    await db.execute(sql`
      insert into tax_groups (id, org_id, code, name, is_active)
      values (${groupId}, ${org.orgId}, 'IMM-GROUP', 'Immutable group', true)`);
    await db.execute(sql`
      insert into tax_group_members (tax_group_id, tax_code_id, sequence)
      values (${groupId}, ${taxA}, 1), (${groupId}, ${taxB}, 2)`);

    const saleA = await seedTaxDocument(org, "customer_invoice", "TAX-IMM-A", taxA, {
      taxCodeId: taxA, sequence: 1, ratePercent: "10", taxableAmount: "100", taxAmount: "10",
      recoverableAmount: "10", nonrecoverableAmount: "0", collectedAccountId: org.accounts.taxOutput, paidAccountId: org.accounts.taxInput,
    });
    // A grouped line carries no document_lines.tax_code_id; both components
    // must still contribute the source base once to their configured boxes.
    const grouped = await seedTaxDocument(org, "customer_invoice", "TAX-IMM-GROUP", taxA, {
      taxCodeId: taxA, sequence: 1, ratePercent: "5", taxableAmount: "100", taxAmount: "5",
      recoverableAmount: "5", nonrecoverableAmount: "0", collectedAccountId: org.accounts.taxOutput, paidAccountId: org.accounts.taxInput,
    }, "100.0000", false);
    await db.execute(sql`update document_lines set tax_code_id = null, tax_group_id = ${groupId} where id = ${grouped.lineId}`);
    const groupedB = await db.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, overridden)
      values (${org.orgId}, ${grouped.lineId}, ${taxB}, 2, '7.5', '100', '7.5000', '7.5000', '0',
              'standard', false, false, 2, null, null, false)
      returning tax_code_id`);
    assert.equal(groupedB.rows[0]?.tax_code_id, taxB);
    await db.execute(sql`update document_lines set tax_amount = '12.5000' where id = ${grouped.lineId}`);
    await db.execute(sql`update documents set tax_total = '12.5000', total = '112.5000', status = 'approved' where id = ${grouped.documentId}`);

    const purchaseGrouped = await seedTaxDocument(org, "vendor_bill", "TAX-IMM-PURCHASE", taxA, {
      taxCodeId: taxA, sequence: 1, ratePercent: "2", taxableAmount: "100", taxAmount: "2",
      recoverableAmount: "2", nonrecoverableAmount: "0", collectedAccountId: org.accounts.taxOutput, paidAccountId: org.accounts.taxInput,
    }, "100.0000", false);
    await db.execute(sql`update document_lines set tax_code_id = null, tax_group_id = ${groupId} where id = ${purchaseGrouped.lineId}`);
    await db.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, overridden)
      values (${org.orgId}, ${purchaseGrouped.lineId}, ${taxB}, 2, '3', '100', '3.0000', '3.0000', '0',
              'standard', false, false, 2, null, null, false)`);
    await db.execute(sql`update document_lines set tax_amount = '5.0000' where id = ${purchaseGrouped.lineId}`);
    await db.execute(sql`update documents set tax_total = '5.0000', total = '105.0000', status = 'approved' where id = ${purchaseGrouped.documentId}`);

    await postDocument(saleA.documentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    await postDocument(grouped.documentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    await postDocument(purchaseGrouped.documentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, 'IMM-RETURN', 'Immutable return', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values
        (${randomUUID()}, ${org.orgId}, 'IMM-RETURN', 'A_BASE', 'A base', ${taxA}, 'taxable_base', 1, 1),
        (${randomUUID()}, ${org.orgId}, 'IMM-RETURN', 'A_TAX', 'A tax', ${taxA}, 'tax_collected', -1, 2),
        (${randomUUID()}, ${org.orgId}, 'IMM-RETURN', 'A_PAID', 'A paid', ${taxA}, 'tax_paid', 1, 3),
        (${randomUUID()}, ${org.orgId}, 'IMM-RETURN', 'B_BASE', 'B base', ${taxB}, 'taxable_base', 1, 4),
        (${randomUUID()}, ${org.orgId}, 'IMM-RETURN', 'B_TAX', 'B tax', ${taxB}, 'tax_collected', -1, 5),
        (${randomUUID()}, ${org.orgId}, 'IMM-RETURN', 'B_PAID', 'B paid', ${taxB}, 'tax_paid', 1, 6)`);
    const before = await computeTaxReturn(org.orgId, 'IMM-RETURN', org.date, org.date);
    const beforeValues = new Map(before.boxes.map((box) => [box.lineCode, box.value]));
    assert.equal(beforeValues.get("A_BASE"), "300.0000");
    assert.equal(beforeValues.get("A_TAX"), "15.0000");
    assert.equal(beforeValues.get("A_PAID"), "2.0000");
    assert.equal(beforeValues.get("B_BASE"), "200.0000");
    assert.equal(beforeValues.get("B_TAX"), "7.5000");
    assert.equal(beforeValues.get("B_PAID"), "3.0000");

    // Repoint both the code and org fallback. Historical lines must continue
    // to classify through their posting-time component account (taxOutput).
    await db.execute(sql`update tax_codes set collected_account_id = ${org.accounts.taxInput}, paid_account_id = ${org.accounts.taxOutput} where id in (${taxA}, ${taxB})`);
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(
           jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,taxCollected}', to_jsonb(${org.accounts.taxInput}::text), true),
           '{controlAccounts,taxPaid}', to_jsonb(${org.accounts.taxOutput}::text), true)
       where id = ${org.orgId}`);
    const after = await computeTaxReturn(org.orgId, 'IMM-RETURN', org.date, org.date);
    assert.deepEqual(after.boxes, before.boxes);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
