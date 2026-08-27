import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import { computeLineTaxes, type TaxComponentConfig } from "./tax.ts";
import { computeTaxReturn } from "./tax-return.ts";
import { quoteExternalTax, saveTaxRateProviderConfig } from "./tax-rate-providers.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function listenTaxServer(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("tax test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function closeTaxServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function bodyOf(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

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

/** Seed one approved document whose tax profile has multiple components. */
async function seedGroupedTaxDocument(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  kind: "customer_invoice" | "vendor_bill",
  number: string,
  groupId: string,
  amount: string,
  components: TaxFixtureComponent[],
): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const accountId = kind === "customer_invoice" ? org.accounts.revenue : org.accounts.cogs;
  const taxAmount = components.reduce((sum, component) => sum + Number(component.taxAmount), 0).toFixed(4);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, ${kind}, 'draft', ${number}, ${org.subsidiaryId},
              ${kind === "customer_invoice" ? org.customerId : org.vendorId}, ${org.date}, ${org.date},
              'CAD', '1', ${amount}, ${taxAmount}, ${Number(amount) + Number(taxAmount)})`);
    await tx.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_group_id, quantity, unit_price)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${accountId}, ${amount},
              ${amount}, ${taxAmount}, ${groupId}, '1', ${amount})`);
    for (const component of components) {
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
    }
    await tx.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  });
  return documentId;
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

test("multi-code tax groups feed each taxable-base box exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const [saleCode1, saleCode2] = [randomUUID(), randomUUID()];
    const [purchaseCode1, purchaseCode2] = [randomUUID(), randomUUID()];
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, calculation_type, collected_account_id, paid_account_id, is_active)
      values
        (${saleCode1}, ${org.orgId}, 'GROUP-SALE-1', 'Group sale 1', 'standard', ${org.accounts.taxOutput}, null, true),
        (${saleCode2}, ${org.orgId}, 'GROUP-SALE-2', 'Group sale 2', 'standard', ${org.accounts.taxOutput}, null, true),
        (${purchaseCode1}, ${org.orgId}, 'GROUP-PURCHASE-1', 'Group purchase 1', 'standard', null, ${org.accounts.taxInput}, true),
        (${purchaseCode2}, ${org.orgId}, 'GROUP-PURCHASE-2', 'Group purchase 2', 'standard', null, ${org.accounts.taxInput}, true)`);

    const saleGroupId = randomUUID();
    const purchaseGroupId = randomUUID();
    await db.execute(sql`
      insert into tax_groups (id, org_id, code, name, is_active)
      values
        (${saleGroupId}, ${org.orgId}, 'GROUP-SALE', 'Grouped sale', true),
        (${purchaseGroupId}, ${org.orgId}, 'GROUP-PURCHASE', 'Grouped purchase', true)`);
    await db.execute(sql`
      insert into tax_group_members (tax_group_id, tax_code_id, sequence)
      values
        (${saleGroupId}, ${saleCode1}, 1), (${saleGroupId}, ${saleCode2}, 2),
        (${purchaseGroupId}, ${purchaseCode1}, 1), (${purchaseGroupId}, ${purchaseCode2}, 2)`);

    const saleId = await seedGroupedTaxDocument(org, "customer_invoice", "GROUP-SALE", saleGroupId, "200.0000", [
      {
        taxCodeId: saleCode1, sequence: 1, ratePercent: "5", taxableAmount: "200.0000",
        taxAmount: "10.0000", recoverableAmount: "10.0000", nonrecoverableAmount: "0.0000",
        collectedAccountId: org.accounts.taxOutput, paidAccountId: null,
      },
      {
        taxCodeId: saleCode2, sequence: 2, ratePercent: "10", taxableAmount: "200.0000",
        taxAmount: "20.0000", recoverableAmount: "20.0000", nonrecoverableAmount: "0.0000",
        collectedAccountId: org.accounts.taxOutput, paidAccountId: null,
      },
    ]);
    const purchaseId = await seedGroupedTaxDocument(org, "vendor_bill", "GROUP-PURCHASE", purchaseGroupId, "150.0000", [
      {
        taxCodeId: purchaseCode1, sequence: 1, ratePercent: "5", taxableAmount: "150.0000",
        taxAmount: "7.5000", recoverableAmount: "7.5000", nonrecoverableAmount: "0.0000",
        collectedAccountId: null, paidAccountId: org.accounts.taxInput,
      },
      {
        taxCodeId: purchaseCode2, sequence: 2, ratePercent: "10", taxableAmount: "150.0000",
        taxAmount: "15.0000", recoverableAmount: "15.0000", nonrecoverableAmount: "0.0000",
        collectedAccountId: null, paidAccountId: org.accounts.taxInput,
      },
    ]);
    const control = { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank };
    await postDocument(saleId, { control });
    await postDocument(purchaseId, { control });

    const formCode = "GROUPED-RETURN";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'Grouped return', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'SALES_BASE', 'Sales base', ${saleCode1}, 'taxable_base', 1, 1),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'SALES_BASE', 'Sales base', ${saleCode2}, 'taxable_base', 1, 2),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'PURCHASE_BASE', 'Purchase base', ${purchaseCode1}, 'taxable_base', 1, 3),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'PURCHASE_BASE', 'Purchase base', ${purchaseCode2}, 'taxable_base', 1, 4),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'SALE_TAX_1', 'Sale tax 1', ${saleCode1}, 'tax_collected', -1, 5),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'SALE_TAX_2', 'Sale tax 2', ${saleCode2}, 'tax_collected', -1, 6),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'PURCHASE_TAX_1', 'Purchase tax 1', ${purchaseCode1}, 'tax_paid', 1, 7),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'PURCHASE_TAX_2', 'Purchase tax 2', ${purchaseCode2}, 'tax_paid', 1, 8)`);

    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
    assert.equal(values.get("SALES_BASE"), "200.0000");
    assert.equal(values.get("PURCHASE_BASE"), "150.0000");
    assert.equal(values.get("SALE_TAX_1"), "10.0000");
    assert.equal(values.get("SALE_TAX_2"), "20.0000");
    assert.equal(values.get("PURCHASE_TAX_1"), "7.5000");
    assert.equal(values.get("PURCHASE_TAX_2"), "15.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("manual aggregate overrides preserve recovery ratio when rounded tax is zero", () => {
  const config: TaxComponentConfig = {
    taxCodeId: "zero-rounded",
    sequence: 1,
    ratePercent: "0",
    recoverablePercent: "40",
  };
  const positive = computeLineTaxes("100", [config], {
    overridden: true,
    taxAmount: "10",
  });
  assert.equal(positive.components[0]?.recoverableAmount, "4.0000");
  assert.equal(positive.components[0]?.nonrecoverableAmount, "6.0000");

  const negative = computeLineTaxes("-100", [config], {
    overridden: true,
    taxAmount: "-10",
  });
  assert.equal(negative.components[0]?.recoverableAmount, "-4.0000");
  assert.equal(negative.components[0]?.nonrecoverableAmount, "-6.0000");
});

test("approved sales and purchases use the configured provider atomically and retain line provenance", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let provider: Server | null = null;
  let calls = 0;
  try {
    const taxCodeId = randomUUID();
    await db.execute(sql`
      insert into tax_codes
        (id, org_id, code, name, recoverable_percent, collected_account_id, paid_account_id, is_active)
      values (${taxCodeId}, ${org.orgId}, 'EXT', 'External tax', '100', ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`);
    await db.execute(sql`
      insert into tax_rates (id, org_id, tax_code_id, rate_percent, effective_from)
      values (${randomUUID()}, ${org.orgId}, ${taxCodeId}, '13', ${org.date})`);

    provider = createServer(async (req, res) => {
      calls++;
      await bodyOf(req);
      if (req.url === "/outage") {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "offline" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        taxAmount: "9.5000",
        components: [{ jurisdiction: "CA", ratePercent: "9.5000", taxAmount: "9.5000" }],
        externalRef: `QUOTE-${calls}`,
      }));
    });
    const origin = await listenTaxServer(provider);
    await saveTaxRateProviderConfig(
      org.orgId,
      { provider: "custom_http", isEnabled: true, preferProvider: true, settings: { quoteUrl: `${origin}/quote` } },
      null,
    );

    async function seedDocument(
      kind: "customer_invoice" | "vendor_bill",
      number: string,
      taxAmount = "13.0000",
    ): Promise<{ id: string; lineId: string }> {
      const id = randomUUID();
      const lineId = randomUUID();
      const partyId = kind === "customer_invoice" ? org.customerId : org.vendorId;
      const accountId = kind === "customer_invoice" ? org.accounts.revenue : org.accounts.cogs;
      const total = taxAmount === "9.5000" ? "109.5000" : "113.0000";
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, party_id, subsidiary_id, document_date,
           currency, subtotal, tax_total, total)
        values (${id}, ${org.orgId}, ${kind}, 'draft', ${number}, ${partyId}, ${org.subsidiaryId}, ${org.date},
                'CAD', '100', ${taxAmount}, ${total})`);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
           tax_amount, tax_code_id, quantity, unit_price)
        values (${lineId}, ${org.orgId}, ${id}, 1, ${accountId}, '100', '100', ${taxAmount}, ${taxCodeId}, '1', '100')`);
      await db.execute(sql`
        insert into document_line_tax_components
          (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
           tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
           price_includes_tax, compound_on_previous, rounding_scale,
           collected_account_id, paid_account_id, overridden)
        values (${org.orgId}, ${lineId}, ${taxCodeId}, 1, '13', '100', ${taxAmount}, ${taxAmount}, '0', 'standard',
                false, false, 2, ${org.accounts.taxOutput}, ${org.accounts.taxInput}, false)`);
      await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
      return { id, lineId };
    }

    const sales = await seedDocument("customer_invoice", "EXT-SALE", "9.5000");
    const purchase = await seedDocument("vendor_bill", "EXT-PURCHASE", "9.5000");
    // Draft calculation is the only provider call and persists the immutable
    // line quote before approval. Posting must only replay this evidence.
    await quoteExternalTax(org.orgId, {
      taxableAmount: "100.0000",
      currency: "CAD",
      shipFrom: {},
      shipTo: {},
      quotedOn: org.date,
      documentLineId: sales.lineId,
    });
    await quoteExternalTax(org.orgId, {
      taxableAmount: "100.0000",
      currency: "CAD",
      shipFrom: {},
      shipTo: {},
      quotedOn: org.date,
      documentLineId: purchase.lineId,
    });
    assert.equal(calls, 2, "draft calculation invokes the configured provider for sales and purchases");
    const deps = { control: {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
      taxCollected: org.accounts.taxOutput,
      taxPaid: org.accounts.taxInput,
    } };
    await postDocument(sales.id, deps, { deferEffects: true, suppressAutomation: true });
    await postDocument(purchase.id, deps, { deferEffects: true, suppressAutomation: true });
    assert.equal(calls, 2, "posting reuses the immutable draft quotes without provider calls");

    const evidence = (await db.execute<{ document_line_id: string; tax_amount: string; external_ref: string | null }>(sql`
      select document_line_id, tax_amount::text, external_ref
        from tax_rate_quotes
       where org_id = ${org.orgId}
       order by created_at, id`)).rows;
    assert.equal(evidence.length, 2);
    assert.deepEqual(evidence.map((row) => row.document_line_id), [sales.lineId, purchase.lineId]);
    assert.deepEqual(evidence.map((row) => row.tax_amount), ["9.5000", "9.5000"]);
    assert.deepEqual(evidence.map((row) => row.external_ref), ["QUOTE-1", "QUOTE-2"]);

    const salesLine = (await db.execute<{ amount: string; tax_amount: string }>(sql`
      select amount::text, tax_amount::text from document_lines where id = ${sales.lineId}`)).rows[0]!;
    assert.deepEqual(salesLine, { amount: "100.0000", tax_amount: "9.5000" });

    // A persisted line quote is the replay authority. Once it exists, a retry
    // does not call a changed/outage endpoint and reuses the same provenance.
    const replay = await seedDocument("customer_invoice", "EXT-REPLAY", "9.5000");
    await quoteExternalTax(org.orgId, {
      taxableAmount: "100.0000",
      currency: "CAD",
      shipFrom: {},
      shipTo: {},
      quotedOn: org.date,
      documentLineId: replay.lineId,
    });
    assert.equal(calls, 3);
    await saveTaxRateProviderConfig(
      org.orgId,
      { provider: "custom_http", isEnabled: true, preferProvider: true, settings: { quoteUrl: `${origin}/outage` } },
      null,
    );
    await postDocument(replay.id, deps, { deferEffects: true, suppressAutomation: true });
    assert.equal(calls, 3, "retry uses the persisted quote instead of re-firing the provider");

    // Explicit local-provider selection means no HTTP call and no external
    // quote is stamped; the statutory local evidence remains authoritative.
    await saveTaxRateProviderConfig(
      org.orgId,
      { provider: "custom_http", isEnabled: true, preferProvider: false },
      null,
    );
    const local = await seedDocument("customer_invoice", "LOCAL-TAX");
    await postDocument(local.id, deps, { deferEffects: true, suppressAutomation: true });
    assert.equal(calls, 3);
    assert.equal((await db.execute(sql`select count(*) from tax_rate_quotes where org_id = ${org.orgId} and document_line_id = ${local.lineId}`)).rows[0]?.count, "0");

    // An approved document without draft provider evidence fails closed before
    // the posting transaction starts: no endpoint call or journal is emitted.
    await saveTaxRateProviderConfig(
      org.orgId,
      { provider: "custom_http", isEnabled: true, preferProvider: true, settings: { quoteUrl: `${origin}/outage` } },
      null,
    );
    const failed = await seedDocument("vendor_bill", "EXT-OUTAGE");
    await assert.rejects(
      postDocument(failed.id, deps, { deferEffects: true, suppressAutomation: true }),
      /no immutable tax-provider quote/,
    );
    assert.equal(calls, 3);
    const failedState = (await db.execute<{ status: string; posted_entry_id: string | null }>(sql`
      select status, posted_entry_id from documents where id = ${failed.id}`)).rows[0]!;
    assert.deepEqual(failedState, { status: "approved", posted_entry_id: null });
    assert.equal((await db.execute(sql`select count(*) from journal_entries where source_document_id = ${failed.id}`)).rows[0]?.count, "0");
    assert.equal((await db.execute(sql`select count(*) from tax_rate_quotes where document_line_id = ${failed.lineId}`)).rows[0]?.count, "0");
  } finally {
    if (provider) await closeTaxServer(provider);
    await dropScratchOrg(org.orgId);
  }
});
