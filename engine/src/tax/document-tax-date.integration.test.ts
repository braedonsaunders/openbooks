import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { documentTaxDate, staleTaxRateLine } from "./document-tax-date.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a credit correcting an earlier invoice is taxed on the invoice's date",
  { skip: !DB },
  async () => {
    // GST moves from 5% to 7% on July 1. A July credit correcting a June
    // invoice adjusts the June supply, so it must carry June's 5%; a credit
    // that corrects nothing keeps its own date and July's 7%.
    const org = await createScratchOrg();
    try {
      const codeId = randomUUID();
      await db.execute(
        sql`insert into tax_codes (id, org_id, code, name, country) values (${codeId}, ${org.orgId}, 'GST-X', 'GST', 'CA')`,
      );
      await db.execute(sql`insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from, effective_to)
      values (${org.orgId}, ${codeId}, '5', '2026-01-01', '2026-06-30'), (${org.orgId}, ${codeId}, '7', '2026-07-01', null)`);
      const document = async (kind: string, number: string, date: string, ratePercent: string) => {
        const id = randomUUID();
        const lineId = randomUUID();
        await db.execute(sql`insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total)
        values (${id}, ${org.orgId}, ${kind}, 'draft', ${number}, ${org.subsidiaryId}, ${org.customerId}, ${date}, 'CAD', '1', '100', '0', '100')`);
        await db.execute(sql`insert into document_lines (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
        values (${lineId}, ${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', '100', '100', ${ratePercent})`);
        await db.execute(sql`insert into document_line_tax_components (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount, tax_amount, recoverable_amount, calculation_type)
        values (${org.orgId}, ${lineId}, ${codeId}, 1, ${ratePercent}, '100', ${ratePercent}, ${ratePercent}, 'standard')`);
        return { id, lineId };
      };
      const invoice = await document("customer_invoice", "INV-JUNE", "2026-06-15", "5");
      const credit = await document("customer_credit", "CM-JULY", "2026-07-10", "7");

      assert.equal(await documentTaxDate(db, org.orgId, credit.id, "2026-07-10"), "2026-07-10");
      assert.equal(await staleTaxRateLine(db, org.orgId, credit.id, "2026-07-10"), undefined);

      await db.execute(sql`insert into document_links (org_id, from_document_id, to_document_id, link_type)
      values (${org.orgId}, ${credit.id}, ${invoice.id}, 'corrects')`);
      assert.equal(await documentTaxDate(db, org.orgId, credit.id, "2026-07-10"), "2026-06-15");
      const stale = await staleTaxRateLine(db, org.orgId, credit.id, "2026-06-15");
      assert.deepEqual(stale && [stale.line_number, stale.code, stale.stored, stale.effective], [
        1,
        "GST-X",
        "7.0000",
        "5.0000",
      ]);

      await db.execute(sql`update document_line_tax_components set rate_percent = '5', tax_amount = '5', recoverable_amount = '5'
      where org_id = ${org.orgId} and document_line_id = ${credit.lineId}`);
      assert.equal(
        await staleTaxRateLine(db, org.orgId, credit.id, "2026-06-15"),
        undefined,
        "a credit recalculated at the corrected invoice's rate is current",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
