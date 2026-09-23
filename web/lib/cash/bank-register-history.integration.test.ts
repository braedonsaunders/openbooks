import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "@openbooks/engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";

const { categoryWeekly } = await import("./core.ts");

type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;

async function seedPeriod(org: ScratchOrg, year: number, month: number): Promise<string> {
  const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id from accounting_periods where id = ${org.periodId}
  `)).rows[0]!.fiscal_calendar_id;
  const id = randomUUID();
  const mm = String(month).padStart(2, "0");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
    values (${id},${org.orgId},${year},${month},${`${year}-${mm}`},${`${year}-${mm}-01`},${`${year}-${mm}-${String(last).padStart(2, "0")}`},false,${cal})`);
  return id;
}

async function seedBankOutflow(org: ScratchOrg, postingDate: string, periodId: string, amount: string): Promise<void> {
  const entry = randomUUID();
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values (${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${postingDate},${periodId},'draft','manual')`);
  await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
    values (${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},${`-${amount}`},'CAD',${`-${amount}`},1),
      (${org.orgId},${entry},2,${org.accounts.adjustment},${org.subsidiaryId},${amount},'CAD',${amount},1)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
}

/**
 * The bank-register strategy shared both GL-history bugs: it divided by
 * weeks with register rows and read through the forecast end. One 1,200
 * outflow in a 12-week window (old books) forecasts 100/week, and a posting
 * dated after asOf leaks into neither the average nor the current week.
 */
test("bank register history uses the shared window average cut at asOf", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      const april = await seedPeriod(org, 2026, 4);
      await seedBankOutflow(org, "2026-04-20", april, "100");
      await seedBankOutflow(org, "2026-07-15", org.periodId, "1200");
      await seedBankOutflow(org, "2026-07-25", org.periodId, "1200");
    });
    await withOrgContext(org.orgId, async () => {
      const category = await categoryWeekly(
        org.orgId,
        { id: randomUUID(), name: "Review", direction: "outflow", method: "bank_register_history", bankAccountIds: [org.accounts.bank], historyWeeks: 12, includeJournals: true },
        "2026-07-20",
        ["2026-07-19", "2026-07-26", "2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30", "2026-09-06"],
        { arWeekly: {}, apWeekly: {}, cashStart: "0.0000" },
      );
      assert.equal(category.meta.weeksUsed, 12);
      assert.equal(category.meta.rawAverage, "100.0000");
      assert.deepEqual(category.weekly, ["100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000"]);
      assert.equal(category.total, "800.0000");
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
