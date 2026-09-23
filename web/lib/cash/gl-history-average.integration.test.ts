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

/**
 * A lone 1,200 outflow inside a 12-week window must forecast 100/week, not
 * 1,200/week: zero-activity weeks are data, not gaps, so the average divides
 * by the full window.
 */
test("gl history average divides by the full window, not active weeks", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      const entry = randomUUID();
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
        values (${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual')`);
      await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        values (${org.orgId},${entry},1,${org.accounts.adjustment},${org.subsidiaryId},'-1200','CAD','-1200',1),
          (${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},'1200','CAD','1200',1)`);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
    });
    await withOrgContext(org.orgId, async () => {
      const category = await categoryWeekly(
        org.orgId,
        { id: randomUUID(), name: "Review", direction: "outflow", method: "gl_history_average", accountIds: [org.accounts.adjustment], historyWeeks: 12 },
        "2026-07-20",
        ["2026-07-19", "2026-07-26", "2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30", "2026-09-06"],
        { arWeekly: {}, apWeekly: {}, cashStart: "0.0000" },
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
 * History stops at asOf: a posting dated after the forecast date must not
 * leak into it — neither into the average nor as an in-horizon actual.
 */
test("gl history average cuts history at asOf", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      for (const [postingDate, entryNumber] of [["2026-07-15", "HIST"], ["2026-07-25", "FUTURE"]] as const) {
        const entry = randomUUID();
        await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
          values (${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entryNumber},${postingDate},${org.periodId},'draft','manual')`);
        await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
          values (${org.orgId},${entry},1,${org.accounts.adjustment},${org.subsidiaryId},'-1200','CAD','-1200',1),
            (${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},'1200','CAD','1200',1)`);
        await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
      }
    });
    await withOrgContext(org.orgId, async () => {
      const category = await categoryWeekly(
        org.orgId,
        { id: randomUUID(), name: "Review", direction: "outflow", method: "gl_history_average", accountIds: [org.accounts.adjustment], historyWeeks: 12 },
        "2026-07-20",
        ["2026-07-19", "2026-07-26", "2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30", "2026-09-06"],
        { arWeekly: {}, apWeekly: {}, cashStart: "0.0000" },
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
