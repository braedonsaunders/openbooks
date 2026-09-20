// F-u1-001: analytics P&L slices must use the full six-type P&L universe.
// An expense_other posting carrying a department tag and a project tag must
// move the Health segment breakdown and Customer profitability, and the
// project slice must tie to the headline P&L.
//
// Run single-file with:
//   OPENBOOKS_TEST_ALLOW_UNMARKED_DB=1 node --import tsx \
//     --import ./engine/src/testing/database-bypass.ts \
//     --test web/lib/analytics-pnl-universe.integration.test.ts   (from repo root)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === '../money-server' && context.parentURL?.includes('/analytics/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' };
  }
  return next(specifier, context);
} });
const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { healthData } = await import('./analytics/health-data');
const { customerProfitability } = await import('./analytics/customer-data');
const { profitAndLoss } = await import('./reports/statements');

test('expense_other with segment + project tags reaches every P&L slice', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Single-file runs do not have the suite's bypass wrapper: fixture
  // create/remove and every seed run inside withBypassContext, while reads
  // through the web readers run inside withOrgContext.
  const org = await withBypassContext(async () => {
    const scoped = await createScratchOrg();
    const deptA = randomUUID();
    const deptB = randomUUID();
    const otherExpense = randomUUID();
    const project = randomUUID();
    await db.execute(sql`insert into departments(id,org_id,name) values (${deptA},${scoped.orgId},'Sales'),(${deptB},${scoped.orgId},'Field')`);
    await db.execute(sql`insert into accounts(id,org_id,number,name,type)
        values (${otherExpense},${scoped.orgId},'7050','Other Expense','expense_other')`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
        values (${project},${scoped.orgId},${scoped.subsidiaryId},'PNL','P&L project',${scoped.customerId},'active',true)`);
    // entry(dept, debitAccount, debitAmount, creditAccount, creditAmount):
    // every leg carries the department and the project tag.
    async function post(dept: string, debitAccount: string, debit: string, creditAccount: string, credit: string) {
      const entry = randomUUID();
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
          values (${entry},${scoped.orgId},${scoped.bookId},${scoped.subsidiaryId},${entry},${scoped.date},${scoped.periodId},'draft','manual')`);
      await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,department_id,project_id,party_id,amount,currency,txn_amount,fx_rate)
          values (${scoped.orgId},${entry},1,${debitAccount},${scoped.subsidiaryId},${dept},${project},${scoped.vendorId},${debit},'CAD',${debit},1),
          (${scoped.orgId},${entry},2,${creditAccount},${scoped.subsidiaryId},${dept},${project},${scoped.vendorId},${credit},'CAD',${credit},1)`);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
    }
    // Dept A: revenue 200 with an expense_other cost of 60.
    await post(deptA, scoped.accounts.bank, '200', scoped.accounts.revenue, '-200');
    await post(deptA, otherExpense, '60', scoped.accounts.bank, '-60');
    // Dept B: an expense_other cost of 40 and nothing else — pre-fix this
    // segment vanishes entirely through the breakdown HAVING clause.
    await post(deptB, otherExpense, '40', scoped.accounts.bank, '-40');
    return { scoped, deptA, deptB };
  });
  try {
    await withOrgContext(org.scoped.orgId, async () => {
      const period = { from: '2026-07-01', to: org.scoped.date, label: 'P&L universe review' };
      const headline = await profitAndLoss(period.from, period.to, undefined, org.scoped.orgId);
      assert.equal(Number(headline.revenue), 200, 'headline control: revenue');
      assert.equal(Number(headline.expenses), 100, 'headline control: expenses include expense_other');

      const profit = await customerProfitability(period, org.scoped.orgId, null);
      assert.equal(profit.summary.totalRevenue, 200);
      assert.equal(profit.summary.totalCost, 100, 'project costs include expense_other legs');
      assert.equal(profit.summary.totalGrossProfit, 100, 'project slice ties to the headline P&L');

      const health = await healthData(period, org.scoped.orgId, null);
      const segA = health.segments.department.find((row) => row.id === org.deptA);
      assert.ok(segA, 'segment with revenue is present');
      assert.equal(segA.revenue, 200);
      const segB = health.segments.department.find((row) => row.id === org.deptB);
      assert.ok(segB, 'segment whose only cost is expense_other is present');
      assert.equal(segB.revenue, 0);
    });
  } finally { await withBypassContext(() => dropScratchOrg(org.scoped.orgId)); }
});
