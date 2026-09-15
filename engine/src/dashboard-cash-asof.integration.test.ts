import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import {
  dashboardFinancialMetricsQuery,
  type DashboardFinancialMetricsRow,
} from "./dashboard-reporting.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * WAVE 4 — the dashboard cash tile summed gl_month_activity over EVERY month
 * with no as-of bound, so a bank line posted after the business day (an open
 * future period) inflated "Cash balance" while the cash cockpit
 * (bankBalances at the same as-of) excluded it. The tile takes `today` and
 * must read cash as of that day: whole summary months before it plus the
 * day's own month from the lines.
 */
test("dashboard cash balance stops at today and ties the cockpit as-of", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`
      select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!;
    await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${calendar.fiscal_calendar_id})`);
    const postBank = async (date: string, periodId: string, amount: string) => {
      const entry = randomUUID();
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${"DC-" + date}, ${date}, ${periodId}, ${"DC-" + date}, 'draft', 'manual')`);
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.adjustment}, ${org.subsidiaryId}, ${"-" + amount}, 'CAD', ${"-" + amount}, '1')`);
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
    };
    await postBank("2026-07-10", org.periodId, "1000.0000");
    const augustPeriodId = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${org.orgId} and starts_on = '2026-08-01'`)).rows[0]!.id;
    // A line dated AFTER the July as-of, in an open future period.
    await postBank("2026-08-05", augustPeriodId, "500.0000");

    const cashAs = async (today: string): Promise<bigint> => {
      const r = (await db.execute(dashboardFinancialMetricsQuery(org.orgId, today))) as unknown as {
        rows: DashboardFinancialMetricsRow[];
      };
      return toUnits(r.rows[0]!.cash_balance);
    };
    assert.equal(await cashAs("2026-07-31"), toUnits("1000.0000"), "July dashboard cash excludes the August line");
    assert.equal(await cashAs("2026-08-05"), toUnits("1500.0000"), "August dashboard cash includes it");

    // Parity with the cockpit's as-of reader over the same lines.
    const cockpit = await db.execute<{ bal: string }>(sql`
      select coalesce(sum(l.amount), 0) as bal
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = ${org.orgId} and e.status in ('posted', 'reversed')
        join accounts a on a.id = l.account_id and a.org_id = ${org.orgId} and a.type = 'asset_bank'
       where l.org_id = ${org.orgId} and e.book_id = ${org.bookId} and e.posting_date <= '2026-07-31'`);
    assert.equal(await cashAs("2026-07-31"), toUnits(cockpit.rows[0]!.bal), "dashboard cash == cockpit cash at the as-of");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
