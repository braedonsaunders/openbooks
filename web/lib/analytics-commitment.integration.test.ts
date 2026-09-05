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
const { spendVelocityData } = await import('./analytics/spend-velocity-data');

for (const scenario of ['empty', 'balanced', 'excess purchases'] as const) {
  test(`Single-month commitment summary: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      if (scenario !== 'empty') {
        for (const kind of ['purchase_order', 'sales_order']) {
          const id = randomUUID();
          const total = scenario === 'excess purchases' && kind === 'purchase_order' ? '250' : '100';
          await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,posting_date,party_id,subsidiary_id,currency,subtotal,tax_total,total)
            values (${id},${org.orgId},${kind},${id},${org.date},${org.date},${kind === 'purchase_order' ? org.vendorId : org.customerId},${org.subsidiaryId},'CAD',${total},0,${total})`);
        }
      }
      await withOrgContext(org.orgId, async () => {
        const data = await spendVelocityData(org.orgId, { from: '2026-07-01', to: '2026-07-31', label: 'Commitment review' }, null);
        const { summary } = data.commitmentCliff;
        assert.equal(summary.totalPO, scenario === 'empty' ? 0 : scenario === 'excess purchases' ? 250 : 100);
        assert.equal(summary.totalSO, scenario === 'empty' ? 0 : 100);
        assert.equal(summary.ratio, scenario === 'empty' ? 0 : scenario === 'excess purchases' ? 2.5 : 1);
        assert.equal(summary.status, scenario === 'excess purchases' ? 'critical' : 'healthy');
        assert.equal(summary.poVelocity, 0);
        assert.equal(summary.soVelocity, 0);
        assert.equal(summary.monthsToCliff, null);
      });
    } finally { await dropScratchOrg(org.orgId); }
  });
}
