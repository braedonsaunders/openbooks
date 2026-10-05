import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { postEntry } from "../journal/post-entry.ts";
import { postDocument } from "./posting-document.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { PostingError } from "../journal/posting-contracts.ts";

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

test("an adjustment period refuses a posting dated outside its fiscal year, in the service and in storage", { skip: !DB }, async () => {
  // The fixture's period is 2026-07 of FY2026; period 13 is FY2026's close
  // bucket. A 2025-06-30 entry naming it would land in FY2025 by date.
  const org = await withBypass(() => createScratchOrg());
  try {
    const adjustment = (await withBypass(async () =>
      (await db.execute<{ id: string }>(sql`
        insert into accounting_periods (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
        select ${org.orgId}, fiscal_calendar_id, 2026, 13, 'FY26 ADJ', '2026-12-31', '2026-12-31', true
          from accounting_periods where id = ${org.periodId}
        returning id`)).rows[0]
    ))!;
    const post = (postingDate: string) => withOrgContext(org.orgId, () => postEntry(db, {
      orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
      entryNumber: `ADJ-${postingDate}`, postingDate, periodId: adjustment.id,
      origin: "manual", currency: "CAD", closeModules: ["gl"],
      lines: [{ accountId: org.accounts.bank, amount: "-10" }, { accountId: org.accounts.cogs, amount: "10" }],
    }));
    // Inside FY2026 (the fiscal year spans its regular periods) is admitted.
    assert.ok((await post(org.date)).entryId);
    await assert.rejects(() => post("2025-06-30"),
      /adjustment period "FY26 ADJ" takes postings dated inside fiscal year 2026 \(2026-07-01 to 2026-12-31\), not 2025-06-30/);
    await assert.rejects(
      () => withBypass(() => db.execute(sql`
        insert into journal_entries (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'ADJ-RAW', '2025-06-30', ${adjustment.id}, 'draft', 'manual')`)),
      // drizzle wraps the driver error; the guard's message is on the cause.
      (e: unknown) => /names adjustment period "FY26 ADJ" of fiscal year 2026/.test(`${e} ${(e as { cause?: unknown }).cause ?? ""}`),
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
