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
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { toUnits } = await import('@openbooks/engine/src/money/money.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { budgetVsActualView } = await import('./budget-report')

const D = '2026-07-14'
const JULY = { from: '2026-07-01', to: '2026-07-31' }
const labels = {
  revenue: 'Revenue', costOfGoodsSold: 'Cost of goods sold', grossProfit: 'Gross profit', expenses: 'Expenses',
  netIncome: 'Net income', totalOf: (section: string) => `Total ${section}`,
  actual: 'Actual', budget: 'Budget', variance: 'Variance', variancePct: 'Variance %',
}

async function seedTwoCurrencyBudget() {
  const org = await withBypass(() => createScratchOrg())
  const usSub = randomUUID()
  await withBypass(async () => {
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`)
    await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD','US Dollar',2) on conflict (code) do nothing`)
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId},'USD','CAD',${D}::date,'spot',1.35,'manual')`)
    // CAD 100 expense in Main (July) + USD 100 expense in US Co (July).
    const legs = [
      ['BW-CAD', org.subsidiaryId, 'CAD', '100'],
      ['BW-USD', usSub, 'USD', '100'],
    ] as const
    for (const [num, sub, cur, amt] of legs) {
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${sub}, ${num}, ${D}, ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${sub}, ${amt}, ${cur}, ${amt}, '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${sub}, ${'-' + amt}, ${cur}, ${'-' + amt}, '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
    }
    // One approved scenario; each subsidiary budgets 1000 in its own book
    // (the guard requires non-zero lines before approval: draft, lines,
    // submit, approve).
    const scenario = randomUUID()
    await db.execute(sql`insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, status)
      values (${scenario}, ${org.orgId}, ${org.bookId}, 2026, 'W2 operating', 'draft')`)
    await db.execute(sql`insert into budget_lines (id, org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
      values (${randomUUID()}, ${org.orgId}, ${scenario}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, '1000'),
             (${randomUUID()}, ${org.orgId}, ${scenario}, ${org.accounts.cogs}, ${org.periodId}, ${usSub}, '1000')`)
    await db.execute(sql`update budget_scenarios set status = 'pending_approval', revision = revision + 1 where id = ${scenario}`)
    await db.execute(sql`update budget_scenarios set status = 'approved', revision = revision + 1 where id = ${scenario}`)
    ;(org as unknown as { w2scenario: string }).w2scenario = scenario
  })
  return org
}

function cogsLine(view: NonNullable<Awaited<ReturnType<typeof budgetVsActualView>>>, cogsId: string) {
  const line = view.lines.find((l) => l.kind === 'account' && 'accountId' in l && l.accountId === cogsId)
  assert.ok(line && line.kind === 'account', 'cogs account line present')
  return line.values as unknown as string[]
}

/**
 * Budget actuals are stated in the org's presentation currency: a USD 100
 * expense in a USD subsidiary is 135 CAD of actuals, and a USD 1000 budget
 * line is 1350 CAD of budget — not 100 / 1000 fused as base units.
 */
test('budget vs actual translates every functional to presentation', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencyBudget()
  try {
    const scenario = (org as unknown as { w2scenario: string }).w2scenario
    await withOrgContext(org.orgId, async () => {
      const view = await budgetVsActualView(scenario, org.orgId, labels, {}, undefined, JULY)
      assert.ok(view, 'scenario resolves')
      const [actual, budget] = cogsLine(view, org.accounts.cogs)
      assert.equal(toUnits(String(actual)), toUnits('235.0000'), 'consolidated actuals translate the USD leg')
      assert.equal(toUnits(String(budget)), toUnits('2350.0000'), 'consolidated budget translates the USD line')
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

/**
 * The budget tree keeps the rolled presentation (F-t08-001 leaves this reader
 * alone), so its section totals must sum depth-0 rows only: a nested expense
 * posted once through a child must total once, not twice (parent rolled +
 * child own). The shared sumSection assumes gross-presentation rows.
 */
test('budget section totals count nested accounts once', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const childId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`insert into accounts (id, org_id, number, name, type)
        values (${childId}, ${org.orgId}, '5010', 'Nested Supplies', 'expense')`)
      await db.execute(sql`update accounts set parent_id = ${childId} where id = ${org.accounts.cogs}`)
      const entry = randomUUID()
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'BN-1', ${D}, ${org.periodId}, 'draft', 'manual')`)
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, '100', 'CAD', '100', '1'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '-100', 'CAD', '-100', '1')`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`)
      const scenario = randomUUID()
      await db.execute(sql`insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, status)
        values (${scenario}, ${org.orgId}, ${org.bookId}, 2026, 'W2 nested', 'draft')`)
      await db.execute(sql`insert into budget_lines (id, org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
        values (${randomUUID()}, ${org.orgId}, ${scenario}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, '1000')`)
      await db.execute(sql`update budget_scenarios set status = 'pending_approval', revision = revision + 1 where id = ${scenario}`)
      await db.execute(sql`update budget_scenarios set status = 'approved', revision = revision + 1 where id = ${scenario}`)
      ;(org as unknown as { w2nested: string }).w2nested = scenario
    })
    const scenario = (org as unknown as { w2nested: string }).w2nested
    await withOrgContext(org.orgId, async () => {
      const view = await budgetVsActualView(scenario, org.orgId, labels, {}, undefined, JULY)
      assert.ok(view, 'scenario resolves')
      const total = view.lines.find((l) => l.kind === 'subtotal' && l.label === 'Total Expenses')
      assert.ok(total && total.kind === 'subtotal', 'expenses subtotal present')
      const [actual, budget] = total.values as unknown as string[]
      assert.equal(toUnits(String(actual)), toUnits('100.0000'), 'nested actuals total once')
      assert.equal(toUnits(String(budget)), toUnits('1000.0000'), 'nested budget totals once')
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})

test('budget vs actual fails closed when a functional has no spot coverage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await seedTwoCurrencyBudget()
  try {
    await withBypass(async () => {
      await db.execute(sql`delete from fx_rates where org_id = ${org.orgId}`)
    })
    const scenario = (org as unknown as { w2scenario: string }).w2scenario
    await withOrgContext(org.orgId, async () => {
      await assert.rejects(budgetVsActualView(scenario, org.orgId, labels, {}, undefined, JULY), /no spot rate for USD/)
    })
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
