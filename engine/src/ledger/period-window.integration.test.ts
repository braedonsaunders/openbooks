import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { postDocument } from "./posting-document.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { PostingError } from "./posting-contracts.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("an imported document dated outside its named period refuses by name", { skip: !DB }, async () => {
  // The sync path posts with an explicit postingPeriodId from the source
  // system; that path used to check only org ownership, so an imported
  // document dated outside its named period posted into it anyway and
  // period-grouped statements disagreed with date-window reports.
  const org = await withBypass(() => createScratchOrg());
  try {
    const otherPeriod = (await withBypass(async () =>
      (await db.execute<{ id: string }>(sql`
        insert into accounting_periods (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on)
        select ${org.orgId}, fiscal_calendar_id, 2027, 1, '2027-01', '2027-01-01', '2027-01-31'
          from accounting_periods where id = ${org.periodId}
        returning id`)).rows[0]
    ))!;
    const docId = crypto.randomUUID();
    await withBypass(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, posting_period_id, created_by)
        values (${docId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-PERIOD-OUT',
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
                '100', '0', '100', ${otherPeriod.id}, null)`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
        values (${org.orgId}, ${docId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0')`);
      await db.execute(sql`
        update documents set status = 'approved', updated_at = now()
         where id = ${docId} and org_id = ${org.orgId}`);
    });
    await assert.rejects(
      () => withBypass(() =>
        postDocument(docId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })
      ),
      (e: unknown) => e instanceof PostingError && /does not cover posting date/.test((e as Error).message),
      "a document dated outside its named period must refuse naming the period and the date",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
