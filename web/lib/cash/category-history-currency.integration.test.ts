import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
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

async function seedOutflow(
  org: ScratchOrg,
  subsidiaryId: string,
  currency: string,
  postingDate: string,
  periodId: string,
  amount: string,
): Promise<void> {
  const entry = randomUUID();
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
    values (${entry},${org.orgId},${org.bookId},${subsidiaryId},${entry},${postingDate},${periodId},'draft','manual')`);
  await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
    values (${org.orgId},${entry},1,${org.accounts.adjustment},${subsidiaryId},${`-${amount}`},${currency},${`-${amount}`},1),
      (${org.orgId},${entry},2,${org.accounts.bank},${subsidiaryId},${amount},${currency},${amount},1)`);
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
}

/**
 * Two subsidiaries' functionals never add raw: a 100 CAD leg in Main Co and
 * a 100 USD leg in US Co (spot 1.35) read as 235 in presentation currency,
 * not 200. A bare sum fuses the functionals and under-forecasts by the rate.
 */
test("gl history translates each subsidiary leg before adding", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const usSub = randomUUID();
    await withBypass(async () => {
      const june = await seedPeriod(org, 2026, 6);
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US')`);
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2) on conflict (code) do nothing`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'USD', 'CAD', '2026-06-01'::date, 'spot', 1.35, 'manual')`);
      await seedOutflow(org, org.subsidiaryId, "CAD", "2026-06-15", june, "100");
      await seedOutflow(org, usSub, "USD", "2026-06-15", june, "100");
    });
    await withOrgContext(org.orgId, async () => {
      const category = await categoryWeekly(
        org.orgId,
        { id: randomUUID(), name: "Reviews", direction: "outflow", method: "gl_history_average", accountIds: [org.accounts.adjustment], historyWeeks: 12 },
        "2026-07-20",
        WEEKS,
        { ...CONTEXT },
      );
      assert.equal(
        category.meta.sourceTotal,
        "235.0000",
        "the window total reads in presentation currency (100 CAD + 100 USD @ 1.35), never the raw 200",
      );
      const sourceRows = category.breakdown.filter((row) => row.type === "Source Data");
      assert.equal(sourceRows.length, 1, "both subsidiaries merge into the one account's source row");
      assert.equal(sourceRows[0]!.amount, "235.0000");
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
