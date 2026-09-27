import assert from 'node:assert/strict'
import test from 'node:test'

const { withSimClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { expensesDashboard } = await import('./expenses-dashboard.ts')
const { seedExpensesDashboardBookScope } = await import('./test-report-fixtures.ts')

test('expense categories exclude secondary-book journal amounts', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    await seedExpensesDashboardBookScope(org)
    await withSimClock('2026-07-15', async () => {
      const dashboard = await expensesDashboard(org.orgId, null)
      const category = dashboard.categories.find((row) => row.categoryId === org.accounts.cogs)
      assert.equal(category?.currentAmount, '100.0000')
      assert.equal(dashboard.monthlyTrends.find((row) => row.month === '2026-07')?.expenseAmount, '100.0000')
      assert.equal(dashboard.summary.expenseReportTotal, '100.0000')
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
