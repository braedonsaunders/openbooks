import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { dashboardFinancialMetricsQuery, type DashboardFinancialMetricsRow } from "./dashboard-reporting.ts";
import { db } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";

/**
 * Post a balanced two-line bank journal straight into one accounting book.
 * Mirrors engine/src/banking-book-scope.integration.test.ts: parallel books
 * each hold their own representation of bank activity.
 */
async function postBankJournalToBook(
  orgId: string,
  subsidiaryId: string,
  periodId: string,
  actorId: string,
  bankAccountId: string,
  offsetAccountId: string,
  bookId: string,
  date: string,
  bankAmount: string,
  label: string,
): Promise<void> {
  const entryId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values
        (${entryId}, ${orgId}, ${bookId}, ${subsidiaryId},
         ${`DASH-${label}-${entryId.slice(0, 8)}`}, ${date}, ${periodId},
         ${`Dashboard book-scope ${label}`}, 'draft', 'manual', ${actorId}, ${actorId})
    `);
    const offsetAmount = fromUnits(-toUnits(bankAmount));
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, memo)
      values
        (${orgId}, ${entryId}, 1, ${bankAccountId}, ${subsidiaryId},
         ${bankAmount}, 'CAD', ${bankAmount}, 1, ${label}),
        (${orgId}, ${entryId}, 2, ${offsetAccountId}, ${subsidiaryId},
         ${offsetAmount}, 'CAD', ${offsetAmount}, 1, ${label})
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_by = ${actorId}, updated_by = ${actorId}
       where id = ${entryId} and org_id = ${orgId}
    `);
  });
}

test("dashboard cash balance reads the primary book only", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Dashboard reader", "admin");
    const secondary = randomUUID();
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${secondary},${org.orgId},'TAX','Tax',false,true,true)`);
    await postBankJournalToBook(
      org.orgId, org.subsidiaryId, org.periodId, actor,
      org.accounts.bank, org.accounts.adjustment, org.bookId, org.date, "500.0000", "primary",
    );
    await postBankJournalToBook(
      org.orgId, org.subsidiaryId, org.periodId, actor,
      org.accounts.bank, org.accounts.adjustment, secondary, org.date, "300.0000", "secondary",
    );

    // Both books hold bank activity in the maintained summary.
    const summary = (await db.execute<{ book_id: string; debit: string }>(sql`
      select book_id, sum(debit_total)::text as debit from gl_month_activity
       where org_id = ${org.orgId} group by book_id order by book_id
    `)).rows;
    assert.equal(summary.length, 2, "expected one summary row-set per book");

    const result = (await db.execute(
      dashboardFinancialMetricsQuery(org.orgId, org.date),
    )) as unknown as { rows: DashboardFinancialMetricsRow[] };
    const cash = result.rows[0]!.cash_balance;
    assert.equal(
      toUnits(cash),
      toUnits("500.0000"),
      `dashboard cash must read the primary book only (got ${cash})`,
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
