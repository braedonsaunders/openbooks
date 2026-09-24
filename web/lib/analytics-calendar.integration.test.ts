import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const {withBypass,withOrgContext} = await import('@openbooks/engine/src/platform/db.ts');
const {createScratchOrg,dropScratchOrg} = await import('@openbooks/engine/src/testing/fixtures.ts');
const {healthData} = await import('./analytics/health-data');
const {financialHealth} = await import('./analytics/financial-health');
const {customerData} = await import('./analytics/customer-data');
const {vendorData} = await import('./analytics/vendor-data');
const {spendVelocityData} = await import('./analytics/spend-velocity-data');

// Every analytics reader accepts the leap-day-adjacent ranges and returns the
// requested period unchanged. Empty scratch orgs make its zero-valued
// aggregate defaults independently observable.
const ranges = [
  { from: '2024-02-01', to: '2024-02-29' },
  { from: '2024-02-29', to: '2024-03-31' },
  { from: '2024-03-01', to: '2024-03-31' },
] as const;

test('the health dashboard echoes each calendar range with zero aggregates', async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await healthData({ ...range, label: 'Calendar review' }, org.orgId, null);
        assert.deepEqual(
          [result.period?.from, result.period?.to, result.period?.label],
          [range.from, range.to, 'Calendar review'],
        );
        assert.equal(result.figures.revenue, 0);
        assert.equal(result.monthly.length, 12);
        assert.equal(result.budget.totals.actual, 0);
        assert.deepEqual(result.segments.department, []);
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test('the health score echoes each calendar range with zero figures', async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await financialHealth({ ...range, label: 'Calendar review' }, undefined, org.orgId, null);
        assert.deepEqual(
          [result.period.from, result.period.to, result.period.label, result.period.months],
          [range.from, range.to, 'Calendar review', 1],
        );
        assert.equal(result.figures.revenue, 0);
        assert.equal(result.figures.netIncome, 0);
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test('the customer view echoes each calendar range with zero customers', async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await customerData({ ...range, label: 'Calendar review' }, org.orgId, null);
        assert.deepEqual(result.period, { ...range, label: 'Calendar review' });
        assert.deepEqual(result.rows, []);
        assert.equal(result.kpis.totalRevenue, 0);
        assert.equal(result.kpis.totalCustomers, 0);
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test('the vendor view echoes each calendar range with zero spend', async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await vendorData({ ...range, label: 'Calendar review' }, org.orgId, null);
        assert.deepEqual(result.period, { ...range, label: 'Calendar review' });
        assert.deepEqual(result.rows, []);
        assert.equal(result.totals.vendors, 0);
        assert.equal(result.totals.spend, 0);
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test('the spend velocity view echoes each calendar range with zero spend', async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      for (const range of ranges) {
        const result = await spendVelocityData(org.orgId, { ...range, label: 'Calendar review' }, null);
        assert.deepEqual(result.period, { ...range, label: 'Calendar review' });
        assert.equal(result.summary.totalSpend, 0);
        assert.equal(result.summary.accountCount, 0);
      }
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});
