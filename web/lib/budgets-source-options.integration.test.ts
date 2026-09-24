import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, _context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
  return next(specifier)
} })

const { sql } = await import('drizzle-orm')
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { listBudgetSourceOptions } = await import('./budgets')

test('budget source options omit scenarios whose lines belong only to hidden subsidiaries', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const hiddenSub = randomUUID()
      const visibleScenario = randomUUID()
      const hiddenScenario = randomUUID()
      const mixedScenario = randomUUID()
      await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSub}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden budget entity', 'CAD', 'CA')`)
      await db.execute(sql`insert into budget_scenarios(id, org_id, book_id, fiscal_year, name, kind)
        values (${visibleScenario}, ${org.orgId}, ${org.bookId}, 2026, 'Visible scenario', 'budget'),
               (${hiddenScenario}, ${org.orgId}, ${org.bookId}, 2026, 'Hidden scenario', 'budget'),
               (${mixedScenario}, ${org.orgId}, ${org.bookId}, 2026, 'Mixed scenario', 'budget')`)
      await db.execute(sql`insert into budget_lines(org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
        values (${org.orgId}, ${visibleScenario}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, '10'),
               (${org.orgId}, ${hiddenScenario}, ${org.accounts.cogs}, ${org.periodId}, ${hiddenSub}, '20'),
               (${org.orgId}, ${mixedScenario}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, '30'),
               (${org.orgId}, ${mixedScenario}, ${org.accounts.cogs}, ${org.periodId}, ${hiddenSub}, '40')`)

      const visible = await listBudgetSourceOptions(org.orgId, new Set([org.subsidiaryId]))
      const visibleIds = new Set(visible.map((scenario) => scenario.id))
      assert.ok(visibleIds.has(visibleScenario))
      assert.ok(visibleIds.has(mixedScenario))
      assert.ok(!visibleIds.has(hiddenScenario))
      const unrestricted = await listBudgetSourceOptions(org.orgId, null)
      assert.ok(unrestricted.some((scenario) => scenario.id === hiddenScenario))
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
