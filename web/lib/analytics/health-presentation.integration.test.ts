import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(specifier)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { healthData } = await import('./health-data')
// health-data pulls in web/lib/auth, whose request-org module registers its
// Next request-store RLS resolver at import time — after the runner's trusted
// test bypass. Outside a request that resolver denies everything, so scratch
// reads come back empty. Re-assert the bypass here, after every import.
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/test-database-bypass.ts')
installTrustedTestDatabaseBypass()

const D = '2026-07-14'
const JULY = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

async function seedTwoCurrencyHealth() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  const dept = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
      values (${dept}, ${org.orgId}, 'Ops', true, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    await db.execute(sql`insert into consolidated_fx_rates (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate)
      values (${org.orgId}, ${org.periodId}, 'USD', 'CAD', 1.35, 1.35, 1.3)`)
    // The prior-year comparison window translates through its own period's
    // set, so it needs one too (same rule as the formal statements).
    const calRow = await db.execute(sql`select fiscal_calendar_id from accounting_periods where id = ${org.periodId}`)
    const calRow0 = calRow.rows[0]
    if (!calRow0) throw new Error('scratch period has no fiscal calendar')
    const priorPeriod = randomUUID()
    await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${priorPeriod}, ${org.orgId}, 2025, 7, '2025-07', '2025-07-01', '2025-07-31', false, ${String(calRow0.fiscal_calendar_id)})`)
    await db.execute(sql`insert into consolidated_fx_rates (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate)
      values (${org.orgId}, ${priorPeriod}, 'USD', 'CAD', 1.3, 1.3, 1.3)`)
    // Revenue: CAD 200 (Main) + USD 100 (US Co). Expense: CAD 100 (Main) +
    // USD 100 (US Co), tagged to Ops so the segment path is exercised.
    const postings = [
      ['REV-CAD', org.subsidiaryId, org.accounts.revenue, '200', null],
      ['REV-USD', usSub, org.accounts.revenue, '100', null],
      ['EXP-CAD', org.subsidiaryId, org.accounts.cogs, '100', dept],
      ['EXP-USD', usSub, org.accounts.cogs, '100', dept],
    ] as const
    for (const [num, sub, account, amt, department] of postings) {
      const entry = randomUUID()
      const isRevenue = account === org.accounts.revenue
      const leg = isRevenue ? '-' + amt : amt
      const contra = isRevenue ? amt : '-' + amt
      const cur = sub === usSub ? 'USD' : 'CAD'
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${account}, ${sub}, ${department}, ${leg}, ${cur}, ${leg}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${sub}, ${department}, ${contra}, ${cur}, ${contra}, '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    }
    const scenario = randomUUID()
    await db.execute(sql`insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, status)
      values (${scenario}, ${org.orgId}, ${org.bookId}, 2026, 'W2 health', 'draft')`)
    await db.execute(sql`insert into budget_lines (id, org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
      values (${randomUUID()}, ${org.orgId}, ${scenario}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, '1000'),
             (${randomUUID()}, ${org.orgId}, ${scenario}, ${org.accounts.cogs}, ${org.periodId}, ${usSub}, '1000')`)
    await db.execute(sql`update budget_scenarios set status = 'pending_approval', revision = revision + 1 where id = ${scenario}`)
    await db.execute(sql`update budget_scenarios set status = 'approved', revision = revision + 1 where id = ${scenario}`)
  })
  return org
}

/**
 * Every health-dashboard reader states presentation currency: USD 100 legs
 * are 135 CAD everywhere — the monthly series, the segment split, the
 * account drivers, the item analysis and the budget tab — never 100 fused.
 */
test('health dashboard translates every reader to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencyHealth()
  try {
    await withOrgContext(org.orgId, async () => {
      const data = await healthData(JULY, org.orgId, null)
      const july = data.monthly.find((m) => m.month === '2026-07')!
      assert.equal(july.revenue, 335)
      // The scratch "cogs" account carries type 'expense', so the legs land
      // in the opex bucket — the translated bucket is what matters here.
      assert.equal(july.opex, 235)

      const ops = data.segments.department.find((s) => s.name === 'Ops')!
      assert.ok(ops, 'Ops segment present')
      assert.equal(ops.operatingIncome, -235)

      const cogsDriver = data.drivers.cost.find((d) => d.id === org.accounts.cogs)!
      assert.ok(cogsDriver, 'cogs driver present')
      assert.equal(cogsDriver.current, 235)

      const revenueItem = data.items.rows.find((r) => r.id === org.accounts.revenue)!
      assert.ok(revenueItem, 'revenue item present')
      assert.equal(revenueItem.current, 335)

      // Totals sum every row (revenue included, pre-existing shape); the
      // per-row figures prove each side translates.
      const cogsBudget = data.budget.rows.find((r) => r.accountId === org.accounts.cogs)!
      assert.equal(cogsBudget.actual, 235)
      assert.equal(cogsBudget.budget, 2350)
      const revenueBudget = data.budget.rows.find((r) => r.accountId === org.accounts.revenue)!
      assert.equal(revenueBudget.actual, 335)
      assert.equal(data.budget.totals.actual, 570)
      assert.equal(data.budget.totals.budget, 2350)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('health dashboard fails closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencyHealth()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    await withOrgContext(org.orgId, async () => {
      await assert.rejects(healthData(JULY, org.orgId, null), /no spot rate for USD/)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
