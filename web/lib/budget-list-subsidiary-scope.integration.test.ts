import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { ListViewConfig } from '@openbooks/customization'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { entityListSource } = await import('./list/entity-sources.ts')

test('budget scenario rows and totals honor the caller subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const hiddenSubsidiary = randomUUID()
    const visibleScenario = randomUUID()
    const mixedScenario = randomUUID()
    const hiddenScenario = randomUUID()
    const emptyScenario = randomUUID()
    const hiddenYearScenario = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden budget entity', 'CAD', 'CA')
      `)
      for (const [id, name, fiscalYear] of [
        [visibleScenario, 'Visible budget', 2026],
        [mixedScenario, 'Mixed budget', 2026],
        [hiddenScenario, 'Hidden budget', 2026],
        [emptyScenario, 'Empty budget', 2026],
        [hiddenYearScenario, 'Hidden year budget', 2027],
      ] as const) {
        await db.execute(sql`
          insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
          values (${id}, ${scratch.orgId}, ${scratch.bookId}, ${fiscalYear}, ${`${name}-${id.slice(0, 8)}`}, 'budget', 'draft')
        `)
      }
      await db.execute(sql`
        insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
        values
          (${scratch.orgId}, ${visibleScenario}, ${scratch.accounts.cogs}, ${scratch.periodId}, ${scratch.subsidiaryId}, 100),
          (${scratch.orgId}, ${mixedScenario}, ${scratch.accounts.cogs}, ${scratch.periodId}, ${scratch.subsidiaryId}, 100),
          (${scratch.orgId}, ${mixedScenario}, ${scratch.accounts.cogs}, ${scratch.periodId}, ${hiddenSubsidiary}, 40),
          (${scratch.orgId}, ${hiddenScenario}, ${scratch.accounts.cogs}, ${scratch.periodId}, ${hiddenSubsidiary}, 999)
      `)
    })

    const source = entityListSource('budget_scenario')
    assert.ok(source)
    const view = {
      schemaVersion: 1,
      recordType: 'budget_scenario',
      columns: [],
      filters: [],
    } as ListViewConfig
    const allowed = new Set([scratch.subsidiaryId])
    const where = source.where(view, { filters: {}, showInactive: false }, scratch.orgId, allowed)
    const joins = typeof source.baseJoins === 'function' ? source.baseJoins(allowed) : source.baseJoins
    const rows = await db.execute<{ id: string; amount: string }>(sql`
      select bs.id, budget_total.amount::text
        from budget_scenarios bs
        ${joins}
       where ${where}
       order by bs.name
    `)
    assert.deepEqual(rows.rows, [
      { id: mixedScenario, amount: '100.0000' },
      { id: visibleScenario, amount: '100.0000' },
    ])

    const unrestrictedWhere = source.where(view, { filters: {}, showInactive: false }, scratch.orgId, null)
    const unrestrictedJoins = typeof source.baseJoins === 'function' ? source.baseJoins(null) : source.baseJoins
    const unrestrictedRows = await db.execute<{ id: string }>(sql`
      select bs.id
        from budget_scenarios bs
        ${unrestrictedJoins}
       where ${unrestrictedWhere}
    `)
    assert.ok(unrestrictedRows.rows.some((row) => row.id === emptyScenario))

    const yearFilter = source.quickFilters.find((filter) => filter.filterKey === 'fiscal_year')
    assert.ok(yearFilter?.loadOptions)
    const years = await yearFilter.loadOptions(scratch.orgId, allowed)
    assert.deepEqual(years.map((option) => option.value), ['2026'])
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
