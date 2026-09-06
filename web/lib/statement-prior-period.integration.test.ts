import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * RP8 — `compare=prior_period` built the comparative as an EQUAL-DAY window
 * (Feb 1–28 compared to Jan 4–31, dropping Jan 1–3). The comparative for a
 * window that aligns to accounting periods is the same number of periods
 * immediately preceding it; a non-aligned window keeps the equal-length
 * comparative and says so in the column label.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/db.ts')) as typeof import('@openbooks/engine/src/db.ts')
const { toUnits } = (await import(root + 'engine/src/money.ts')) as typeof import('@openbooks/engine/src/money.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { profitAndLoss } = (await import(root + 'web/lib/reports.ts')) as typeof import('./reports')
const { priorAccountingWindow, profitAndLossView } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')

const labels = {
  revenue: 'Revenue', costOfGoodsSold: 'Cost of goods sold', grossProfit: 'Gross profit', expenses: 'Expenses',
  netIncome: 'Net income', totalOf: (section: string) => `Total ${section}`,
}

test('prior_period compares against the preceding accounting period(s), not an equal-day window', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const periodIds: Record<string, string> = {}
    await withBypassContext(async () => {
      const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
      // Jan–Jun 2026 on the fixture's calendar (the fixture ships July only).
      for (const [n, from, to] of [[1, '2026-01-01', '2026-01-31'], [2, '2026-02-01', '2026-02-28'], [3, '2026-03-01', '2026-03-31'], [4, '2026-04-01', '2026-04-30'], [5, '2026-05-01', '2026-05-31'], [6, '2026-06-01', '2026-06-30']] as const) {
        const id = randomUUID()
        periodIds[from] = id
        await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${id}, ${org.orgId}, 2026, ${n}, ${'2026-' + String(n).padStart(2, '0')}, ${from}, ${to}, false, ${calendar.fiscal_calendar_id})`)
      }
      const post = async (date: string, amount: string) => {
        const periodId = periodIds[date.slice(0, 8) + '01'] ?? org.periodId
        const entry = randomUUID()
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${'PP-' + date}, ${date}, ${periodId}, ${'PP-' + date}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                 (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
      }
      // Jan 1–3 carry revenue the equal-day window (Jan 4–31) would drop.
      await post('2026-01-02', '300.0000')
      await post('2026-01-20', '100.0000')
      await post('2026-02-10', '50.0000')
      await post('2026-03-05', '20.0000')
      await post('2026-05-09', '7.0000')
    })
    await withOrgContext(org.orgId, async () => {
      const february = { from: '2026-02-01', to: '2026-02-28' }
      const view = await profitAndLossView(february, 'February 2026', labels, { orgId: org.orgId, compare: 'prior_period' })
      const prior = view.columns[1]!
      assert.equal(prior.label, 'Prior period')
      assert.deepEqual([prior.from, prior.to], ['2026-01-01', '2026-01-31'], 'February compares to ALL of January')
      const netIncome = view.lines.find((l) => l.label === 'Net income')!.values!
      const january = await profitAndLoss('2026-01-01', '2026-01-31', undefined, org.orgId)
      assert.equal(toUnits(netIncome[0]!), toUnits('50.0000'))
      assert.equal(toUnits(netIncome[1]!), toUnits(january.netIncome), 'prior column equals the January P&L')
      assert.equal(toUnits(netIncome[1]!), toUnits('400.0000'))

      // A run of periods (a quarter) compares to the preceding run.
      const q2 = await priorAccountingWindow(org.orgId, { from: '2026-04-01', to: '2026-06-30' })
      assert.deepEqual(q2, { from: '2026-01-01', to: '2026-03-31', aligned: true })
      const quarter = await profitAndLossView({ from: '2026-04-01', to: '2026-06-30' }, 'Q2 2026', labels, { orgId: org.orgId, compare: 'prior_period' })
      const quarterNet = quarter.lines.find((l) => l.label === 'Net income')!.values!
      assert.deepEqual([toUnits(quarterNet[0]!), toUnits(quarterNet[1]!)], [toUnits('7.0000'), toUnits('470.0000')], 'Q2 compares to Q1 (300 + 100 + 50 + 20)')

      // Not period-aligned: equal-length comparative, labelled as such.
      const partial = await priorAccountingWindow(org.orgId, { from: '2026-02-03', to: '2026-02-28' })
      assert.deepEqual(partial, { from: '2026-01-08', to: '2026-02-02', aligned: false })
      const partialView = await profitAndLossView({ from: '2026-02-03', to: '2026-02-28' }, 'Feb 3–28', labels, { orgId: org.orgId, compare: 'prior_period' })
      assert.equal(partialView.columns[1]!.label, 'Prior period (equal length)')
      // Aligned, but the calendar starts here: equal length, disclosed.
      const first = await priorAccountingWindow(org.orgId, { from: '2026-01-01', to: '2026-01-31' })
      assert.deepEqual(first, { from: '2025-12-01', to: '2025-12-31', aligned: false })
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
