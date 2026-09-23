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

async function seedJournal(
  org: ScratchOrg,
  postingDate: string,
  periodId: string,
  legs: Array<[string, string]>,
  sourceDocumentId: string | null,
): Promise<string> {
  const entry = randomUUID();
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
    values (${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${entry},${postingDate},${periodId},'draft','manual',${sourceDocumentId})`);
  let line = 0;
  for (const [accountId, amount] of legs) {
    line += 1;
    await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values (${org.orgId},${entry},${line},${accountId},${org.subsidiaryId},${amount},'CAD',${amount},1)`);
  }
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
  return entry;
}

/**
 * An internal transfer between two selected banks is one debit and one
 * credit inside the viewed set: it nets to zero instead of counting the
 * outflow leg as spending. A transfer to an out-of-scope account keeps its
 * leg — cash really left the viewed set.
 */
test("bank register nets internal transfers between selected banks", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const secondBank = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into accounts(id,org_id,number,name,type)
        values (${secondBank},${org.orgId},'1010','Second bank','asset_bank')`);
      const april = await seedPeriod(org, 2026, 4);
      await seedJournal(org, "2026-04-20", april, [[org.accounts.bank, "-120"], [org.accounts.adjustment, "120"]], null);
      await seedJournal(org, org.date, org.periodId, [[org.accounts.bank, "-1200"], [org.accounts.adjustment, "1200"]], null);
      const transferId = randomUUID();
      await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,document_date,currency,fx_rate,subtotal,tax_total,total)
        values (${transferId},${org.orgId},'transfer','approved','TRANSFER-1',${org.subsidiaryId},${org.date},'CAD','1',500,0,500)`);
      const transferEntry = await seedJournal(
        org, org.date, org.periodId,
        [[org.accounts.bank, "-500"], [secondBank, "500"]],
        transferId,
      );
      await db.execute(sql`update documents set posted_entry_id = ${transferEntry} where id = ${transferId}`);
    });
    await withOrgContext(org.orgId, async () => {
      const category = await categoryWeekly(
        org.orgId,
        { id: randomUUID(), name: "Review", direction: "outflow", method: "bank_register_history", bankAccountIds: [org.accounts.bank, secondBank], historyWeeks: 12, includeJournals: true },
        "2026-07-20",
        ["2026-07-19", "2026-07-26", "2026-08-02", "2026-08-09", "2026-08-16", "2026-08-23", "2026-08-30", "2026-09-06"],
        { arWeekly: {}, apWeekly: {}, cashStart: "0.0000" },
      );
      // 1200 over 12 weeks (the April leg only establishes old books); the
      // 500 transfer nets to zero instead of forecasting as spending.
      assert.equal(category.meta.weeksUsed, 12);
      assert.equal(category.meta.rawAverage, "100.0000");
      assert.deepEqual(category.weekly, ["100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000", "100.0000"]);
      assert.equal(category.total, "800.0000");
      assert.ok(category.breakdown.every((row) => !row.name.includes("TRANSFER-1")), "the internal transfer leaves no register row");
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
