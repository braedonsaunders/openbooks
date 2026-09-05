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
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts');
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts');
const { vendorData } = await import('./analytics/vendor-data');
const { spendVelocityData } = await import('./analytics/spend-velocity-data');
const { customerProfitability } = await import('./analytics/customer-data');

for (const view of ['vendor total', 'vendor months', 'spend accounts', 'spend vendors', 'spend revenue', 'spend categories', 'spend comparison', 'customer profitability'] as const) {
  for (const scenario of ['posted control', 'secondary book', 'draft entries', 'reversed history'] as const) {
    test(`Analytics ledger ${view}: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const project = randomUUID();
        const taxBook = randomUUID();
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
          values (${project},${org.orgId},${org.subsidiaryId},'LEDGER','Ledger project',${org.customerId},'active',true)`);
        await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
          values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
        async function ledger(book: string, status: 'posted' | 'draft' | 'reversed', cost: string, revenue: string) {
          const entry = randomUUID();
          const document = randomUUID();
          await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency)
            values (${document},${org.orgId},'vendor_bill',${document},${org.date},${org.date},${org.vendorId},${org.subsidiaryId},'CAD')`);
          await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id)
            values (${entry},${org.orgId},${book},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual',${document})`);
          await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,project_id,party_id,amount,currency,txn_amount,fx_rate)
            values (${org.orgId},${entry},1,${org.accounts.cogs},${org.subsidiaryId},${project},${org.vendorId},${cost},'CAD',${cost},1),
            (${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},${project},${org.vendorId},-${cost}::numeric,'CAD',-${cost}::numeric,1),
            (${org.orgId},${entry},3,${org.accounts.revenue},${org.subsidiaryId},${project},${org.customerId},-${revenue}::numeric,'CAD',-${revenue}::numeric,1),
            (${org.orgId},${entry},4,${org.accounts.bank},${org.subsidiaryId},${project},${org.customerId},${revenue},'CAD',${revenue},1)`);
          if (status !== 'draft') {
            await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`);
            await db.execute(sql`update documents set status='posted',posted_entry_id=${entry},posting_period_id=${org.periodId} where id=${document}`);
          }
          if (status === 'reversed') await db.execute(sql`update journal_entries set status='reversed' where id=${entry}`);
        }
        await ledger(org.bookId, 'posted', '100', '200');
        if (scenario === 'secondary book') await ledger(taxBook, 'posted', '700', '1400');
        if (scenario === 'draft entries') await ledger(org.bookId, 'draft', '900', '1800');
        if (scenario === 'reversed history') {
          await ledger(org.bookId, 'reversed', '300', '600');
          await ledger(org.bookId, 'posted', '-300', '-600');
        }
        await withOrgContext(org.orgId, async () => {
          const period = { from: '2026-07-01', to: '2026-07-31', label: 'Ledger review' };
          if (view === 'vendor total' || view === 'vendor months') {
            const data = await vendorData(period, org.orgId);
            if (view === 'vendor total') assert.equal(data.totals.spend, 100);
            else assert.equal(data.monthly.find(row => row.month === '2026-07')?.spend, 100);
          } else if (view === 'customer profitability') {
            const data = await customerProfitability(period, org.orgId);
            assert.equal(data.summary.totalRevenue, 200);
            assert.equal(data.summary.totalCost, 100);
            assert.equal(data.summary.totalGrossProfit, 100);
          } else {
            const data = await spendVelocityData(org.orgId, period);
            if (view === 'spend accounts') assert.equal(data.summary.totalSpend, 100);
            if (view === 'spend vendors') assert.equal(data.vendorVelocity.find(row => row.id === org.vendorId)?.totalSpend, 100);
            if (view === 'spend revenue') assert.equal(data.revenue.totalRevenue, 200);
            if (view === 'spend categories') assert.equal(data.expenseAnalysis.categories.find(row => row.categoryId === org.accounts.cogs)?.currentAmount, 100);
            if (view === 'spend comparison') assert.equal(data.periodComparison.summary.currentTotal, 100);
          }
        });
      } finally { await dropScratchOrg(org.orgId); }
    });
  }
}
