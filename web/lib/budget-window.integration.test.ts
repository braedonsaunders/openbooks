import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * WAVE 4 — budget vs actual resolved the WHOLE fiscal year with no period
 * bound, so a year-to-date view included future-dated actuals the P&L never
 * showed (cogs / expense residuals on the real tenant). The view now takes
 * the same caller-resolved window as every other statement, echoes it on the
 * Actual column, and its actuals equal the P&L's for the same range.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { toUnits } = (await import(root + 'engine/src/money/money.ts')) as typeof import('@openbooks/engine/src/money/money.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { budgetVsActualView } = (await import(root + 'web/lib/budget-report.ts')) as typeof import('./budget-report')
const { profitAndLossView } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')

const labels = {
  revenue: 'Revenue', costOfGoodsSold: 'Cost of goods sold', grossProfit: 'Gross profit', expenses: 'Expenses',
  netIncome: 'Net income', totalOf: (section: string) => `Total ${section}`,
}
const budgetLabels = { ...labels, actual: 'Actual', budget: 'Budget', variance: 'Variance', variancePct: 'Variance %' }

test('budget actuals equal the P&L for the same window and exclude lines past the as-of', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    let augustPeriodId = ''
    await withBypassContext(async () => {
      const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
      augustPeriodId = randomUUID()
      await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${augustPeriodId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${calendar.fiscal_calendar_id})`)
      const post = async (date: string, periodId: string, amount: string) => {
        const entry = randomUUID()
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${'BW-' + date}, ${date}, ${periodId}, ${'BW-' + date}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                 (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
      }
      // July actuals plus August lines that are FUTURE relative to a July as-of.
      await post('2026-07-10', org.periodId, '1000.0000')
      await post('2026-08-05', augustPeriodId, '500.0000')
      // One scenario, monthly budgets on both sides of the as-of.
      const scenario = randomUUID()
      await db.execute(sql`insert into budget_scenarios (id, org_id, book_id, fiscal_year, name) values (${scenario}, ${org.orgId}, ${org.bookId}, 2026, 'W4 operating')`)
      await db.execute(sql`insert into budget_lines (id, org_id, scenario_id, account_id, period_id, amount)
        values (${randomUUID()}, ${org.orgId}, ${scenario}, ${org.accounts.revenue}, ${org.periodId}, '-900.0000'),
               (${randomUUID()}, ${org.orgId}, ${scenario}, ${org.accounts.revenue}, ${augustPeriodId}, '-400.0000')`)
      // Stash the scenario id for the read phase.
      ;(org as unknown as { w4scenario: string }).w4scenario = scenario
    })
    const scenario = (org as unknown as { w4scenario: string }).w4scenario
    const july = { from: '2026-07-01', to: '2026-07-31' }
    await withOrgContext(org.orgId, async () => {
      const view = await budgetVsActualView(scenario, org.orgId, budgetLabels, {}, undefined, july)
      assert.ok(view, 'scenario resolves')
      // The resolved window is echoed on the Actual column.
      assert.deepEqual([view.columns[0]!.from, view.columns[0]!.to], [july.from, july.to])
      const revenueLine = view.lines.find((l) => l.kind === 'account' && 'accountId' in l && l.accountId === org.accounts.revenue)!
      assert.ok(revenueLine && revenueLine.kind === 'account', 'revenue account line present')
      const [actual, budget] = revenueLine.values as unknown as string[]
      assert.equal(toUnits(String(actual)), toUnits('1000.0000'), 'July actuals exclude the August lines')
      assert.equal(toUnits(String(budget)), toUnits('900.0000'), 'July budget excludes the August budget month')

      // Parity with the statement engine for the same range.
      const pnl = await profitAndLossView(july, 'July 2026', labels, { orgId: org.orgId })
      const pnlRevenue = pnl.lines.find((l) => l.label === 'Total Revenue')!.values!
      assert.equal(toUnits(String(actual)), toUnits(String(pnlRevenue[0])), 'budget actuals == P&L actuals for the same window')

      // Omitting the window keeps the legacy whole-fiscal-year behavior.
      const legacy = await budgetVsActualView(scenario, org.orgId, budgetLabels)
      const legacyRevenue = legacy!.lines.find((l) => l.kind === 'account' && 'accountId' in l && l.accountId === org.accounts.revenue)!
      assert.equal(
        toUnits(String((legacyRevenue as unknown as { values: string[] }).values[0])),
        toUnits('1500.0000'),
        'legacy whole-FY window still includes every month',
      )
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
