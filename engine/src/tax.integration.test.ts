import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import { computeLineTaxes, type TaxComponentConfig } from "./tax.ts";
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
    const gl = (await db.execute(sql`
      select account_id, amount from journal_lines where entry_id = ${entryId} order by line_number
    `)) as unknown as { rows: { account_id: string; amount: string }[] };
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
