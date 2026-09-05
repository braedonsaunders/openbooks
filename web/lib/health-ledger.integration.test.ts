import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "../money-server" && context.parentURL?.includes("/analytics/")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}" };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { healthData } = await import("./analytics/health-data");

for (const view of ["current month", "completed month", "segments", "drivers", "items", "operating income"] as const) {
  test(`Financial Health reconciles ${view} to the primary posted ledger`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const taxBook = randomUUID();
      const department = randomUUID();
      const otherIncome = randomUUID();
      await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
        values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
      await db.execute(sql`insert into departments(id,org_id,name) values (${department},${org.orgId},'Operations')`);
      await db.execute(sql`insert into accounts(id,org_id,number,name,type)
        values (${otherIncome},${org.orgId},'4999','Nonoperating income','income_other')`);
      for (const [book, status, amount, account] of [
        [org.bookId, 'posted', '100', org.accounts.revenue],
        [org.bookId, 'posted', '50', otherIncome],
        [taxBook, 'posted', '700', org.accounts.revenue],
        [org.bookId, 'draft', '900', org.accounts.revenue],
      ]) {
        const entry = randomUUID();
        await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
          values (${entry},${org.orgId},${book},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual')`);
        await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,location_id,amount,currency,txn_amount,fx_rate)
          values (${org.orgId},${entry},1,${org.accounts.bank},${org.subsidiaryId},${department},${org.locationId},${amount},'CAD',${amount},1),
          (${org.orgId},${entry},2,${account},${org.subsidiaryId},${department},${org.locationId},${'-' + amount},'CAD',${'-' + amount},1)`);
        if (status === 'posted') await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
      }
      await withOrgContext(org.orgId, async () => {
        const to = view === "completed month" ? "2026-08-15" : org.date;
        const result = await healthData({ from: "2026-07-01", to, label: "Ledger review" }, org.orgId, null);
        assert.equal(result.figures.revenue, 150, "primary-book headline control");
        assert.equal(result.figures.operatingIncome, 100, "nonoperating income excluded in headline");
        const month = result.monthly.find(row => row.month === '2026-07');
        assert.ok(month);
        if (view === "current month" || view === "completed month") assert.equal(month.revenue, result.figures.revenue);
        if (view === "segments") {
          assert.equal(result.segments.department.find(row => row.id === department)?.revenue, 150);
          assert.equal(result.segments.location.find(row => row.id === org.locationId)?.revenue, 150);
        }
        if (view === "drivers") assert.equal(result.drivers.revenue.find(row => row.id === org.accounts.revenue)?.current, 100);
        if (view === "items") {
          assert.equal(result.items.totalCurrent, result.figures.revenue);
          assert.equal(result.items.rows.find(row => row.id === org.accounts.revenue)?.current, 100);
        }
        if (view === "operating income") {
          assert.equal(month.operatingIncome, result.figures.operatingIncome);
          assert.equal(month.netIncome, result.figures.netIncome);
          assert.equal(result.segments.department.find(row => row.id === department)?.operatingIncome, 100);
        }
      });
    } finally { await dropScratchOrg(org.orgId); }
  });
}
