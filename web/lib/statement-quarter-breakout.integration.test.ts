import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Quarter breakout columns must follow the org's fiscal calendar, not the
 * calendar year: with a February fiscal start, Jan 2026 belongs to Q4 FY2026
 * and Feb 2026 opens Q1 FY2027. A January-hardcoded quarter split reports
 * calendar quarters ("Q1 2026") and groups fiscal straddlers wrongly.
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
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/test-fixtures.ts')) as typeof import('@openbooks/engine/src/test-fixtures.ts')
const { statementMatrix, PNL_TYPES } = (await import(root + 'web/lib/statement-matrix.ts')) as typeof import('./statement-matrix')

test('quarter breakout follows the org fiscal start month, not January', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"fiscalYearStartMonth": 2}'::jsonb where id = ${org.orgId}`)
      const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)).rows[0]!
      const periodIds: Record<string, string> = {}
      for (const [n, from, to] of [[11, '2025-11-01', '2025-11-30'], [12, '2025-12-01', '2025-12-31'], [1, '2026-01-01', '2026-01-31'], [2, '2026-02-01', '2026-02-28'], [3, '2026-03-01', '2026-03-31']] as const) {
        const id = randomUUID()
        periodIds[from] = id
        await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${id}, ${org.orgId}, 2026, ${n}, ${'P' + n}, ${from}, ${to}, false, ${calendar.fiscal_calendar_id})`)
      }
      const post = async (date: string, amount: string) => {
        const periodId = periodIds[date.slice(0, 8) + '01'] ?? org.periodId
        const entry = randomUUID()
        await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
          values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${'QB-' + date}, ${date}, ${periodId}, ${'QB-' + date}, 'draft', 'manual')`)
        await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values (${org.orgId}, ${entry}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, '1'),
                 (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, ${'-' + amount}, 'CAD', ${'-' + amount}, '1')`)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
      }
      await post('2026-01-15', '100.0000')
      await post('2026-02-15', '200.0000')
    })
    await withOrgContext(org.orgId, async () => {
      const matrix = await statementMatrix({
        orgId: org.orgId,
        types: [...PNL_TYPES],
        mode: 'flow',
        period: { from: '2026-01-01', to: '2026-03-31' },
        periodLabel: 'Q4 FY2026 – Q1 FY2027',
        breakout: 'quarter',
      })
      assert.equal(matrix.columns.length, 2)
      assert.deepEqual(
        matrix.columns.map((c) => [c.label, c.from, c.to]),
        [
          ['Q4 FY 2026', '2025-11-01', '2026-01-31'],
          ['Q1 FY 2027', '2026-02-01', '2026-04-30'],
        ],
      )
      const revenue = matrix.rows.find((r) => r.name && r.type === 'income')
      assert.ok(revenue, 'expected a revenue row')
      // Jan revenue sits in the fiscal quarter ending January, Feb in the next.
      assert.deepEqual(revenue.values.slice(0, 2).map(String), ['100.0000', '200.0000'])
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId)).catch(() => {})
  }
})
