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

const WEEKS = ["2026-07-19", "2026-07-26", "2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30", "2026-09-06"];
const CONTEXT = { arWeekly: {}, apWeekly: {}, cashStart: "0.0000" } as const;

/** Suites that need historical months seed those periods explicitly. */
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

async function seedOutflow(org: ScratchOrg, postingDate: string, periodId: string, amount: string): Promise<void> {
  const entry = randomUUID();
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values (${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${postingDate},${periodId},'draft','manual')`);
  await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
    values (${org.orgId},${entry},1,${org.accounts.adjustment},${org.subsidiaryId},${`-${amount}`},'CAD',${`-${amount}`},1),
      (${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},${amount},'CAD',${amount},1)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
}

/**
 * A lone 1,200 outflow inside a 12-week window must forecast 100/week, not
 * 1,200/week: zero-activity weeks are data, not gaps, so the average divides
 * by the window's buckets on or after the data start — the full 12 here,
 * because the org's books long predate the window.
 */
test("gl history average divides by the full window, not active weeks", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      // An out-of-window establishing posting: old books, excluded from the
      // window total, so the sparse window still divides by 12.
      const april = await seedPeriod(org, 2026, 4);
      await seedOutflow(org, "2026-04-20", april, "100");
      await seedOutflow(org, org.date, org.periodId, "1200");
    });
    await withOrgContext(org.orgId, async () => {
      const category = await categoryWeekly(
        org.orgId,
        { id: randomUUID(), name: "Review", direction: "outflow", method: "gl_history_average", accountIds: [org.accounts.adjustment], historyWeeks: 12 },
        "2026-07-20",
        WEEKS,
        { ...CONTEXT },
      );
      assert.equal(category.meta.sourceTotal, "1200.0000");
      assert.equal(category.meta.weeksUsed, 12);
      assert.equal(category.meta.rawAverage, "100.0000");
      assert.deepEqual(category.weekly, ["100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000"]);
      assert.equal(category.total, "800.0000");
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

/**
 * A young org with 3 weeks of books in a 12-week window divides by 3: weeks
 * before the data start predate the books and must not dilute the run-rate.
 */
test("gl history average divides a young org by its weeks of books", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      const june = await seedPeriod(org, 2026, 6);
      await seedOutflow(org, "2026-06-29", june, "600");
    });
    await withOrgContext(org.orgId, async () => {
      const category = await categoryWeekly(
        org.orgId,
        { id: randomUUID(), name: "Review", direction: "outflow", method: "gl_history_average", accountIds: [org.accounts.adjustment], historyWeeks: 12 },
        "2026-07-20",
        WEEKS,
        { ...CONTEXT },
      );
      assert.equal(category.meta.sourceTotal, "600.0000");
      assert.equal(category.meta.weeksUsed, 3);
      assert.equal(category.meta.rawAverage, "200.0000");
      assert.deepEqual(category.weekly, ["200.0000", "200.0000", "200.0000", "200.0000", "200.0000", "200.0000", "200.0000", "200.0000"]);
      assert.equal(category.total, "1600.0000");
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

/**
 * History stops at asOf: a posting dated after the forecast date must not
 * leak into it — neither into the average nor as an in-horizon actual.
 */
test("gl history average cuts history at asOf", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      const april = await seedPeriod(org, 2026, 4);
      await seedOutflow(org, "2026-04-20", april, "100");
      await seedOutflow(org, "2026-07-15", org.periodId, "1200");
      await seedOutflow(org, "2026-07-25", org.periodId, "1200");
    });
    await withOrgContext(org.orgId, async () => {
      const category = await categoryWeekly(
        org.orgId,
        { id: randomUUID(), name: "Review", direction: "outflow", method: "gl_history_average", accountIds: [org.accounts.adjustment], historyWeeks: 12 },
        "2026-07-20",
        WEEKS,
        { ...CONTEXT },
      );
      // Only the Jul-15 posting counts: 1,200 over 12 weeks.
      assert.equal(category.meta.sourceTotal, "1200.0000");
      assert.deepEqual(category.weekly, ["100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000"]);
      assert.equal(category.total, "800.0000");
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
