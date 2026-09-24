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

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
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
    const period2027 = randomUUID()
    await withBypass(async () => {
      const cal = await db.execute<{ id: string }>(sql`
        select id from fiscal_calendars where org_id = ${scratch.orgId} and is_default limit 1`)
      await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${period2027}, ${scratch.orgId}, 2027, 7, '2027-07', '2027-07-01', '2027-07-31', false, ${cal.rows[0]!.id})`)
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
          (${scratch.orgId}, ${hiddenScenario}, ${scratch.accounts.cogs}, ${scratch.periodId}, ${hiddenSubsidiary}, 999),
          (${scratch.orgId}, ${hiddenYearScenario}, ${scratch.accounts.cogs}, ${period2027}, ${hiddenSubsidiary}, 10)
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
    // Reads run in an RLS-subject org session (what a real request has), not
    // a bypass: the subsidiary scoping under test still applies in SQL.
    const rows = await withOrgContext(scratch.orgId, () => db.execute<{ id: string; amount: string }>(sql`
      select bs.id, budget_total.amount::text
        from budget_scenarios bs
        ${joins}
       where ${where}
       order by bs.name
    `))
    // The mixed-scope scenario names a subsidiary the caller cannot see while
    // its GET answers 404, so it must be absent from the list (not redacted);
    // the line-less draft touches nothing and stays visible. (The fixture may
    // seed its own scenarios, so assertions scope to the ids created here.)
    const listed = new Set(rows.rows.map((row) => row.id))
    assert.ok(listed.has(emptyScenario), 'line-less draft stays visible')
    assert.ok(listed.has(visibleScenario), 'wholly in-scope scenario stays visible')
    assert.equal(rows.rows.find((row) => row.id === visibleScenario)?.amount, '100.0000')
    for (const absent of [mixedScenario, hiddenScenario, hiddenYearScenario]) {
      assert.ok(!listed.has(absent), `out-of-scope scenario listed: ${absent}`)
    }

    const unrestrictedWhere = source.where(view, { filters: {}, showInactive: false }, scratch.orgId, null)
    const unrestrictedJoins = typeof source.baseJoins === 'function' ? source.baseJoins(null) : source.baseJoins
    const unrestrictedRows = await withOrgContext(scratch.orgId, () => db.execute<{ id: string }>(sql`
      select bs.id
        from budget_scenarios bs
        ${unrestrictedJoins}
       where ${unrestrictedWhere}
    `))
    const unrestricted = new Set(unrestrictedRows.rows.map((row) => row.id))
    for (const id of [emptyScenario, hiddenScenario, hiddenYearScenario, mixedScenario, visibleScenario]) {
      assert.ok(unrestricted.has(id), `unrestricted list hides a scenario: ${id}`)
    }

    const yearFilter = source.quickFilters.find((filter) => filter.filterKey === 'fiscal_year')
    const loadYearOptions = yearFilter?.loadOptions
    assert.ok(loadYearOptions)
    const years = await withOrgContext(scratch.orgId, () => loadYearOptions(scratch.orgId, allowed))
    const yearValues = years.map((option) => option.value)
    assert.ok(yearValues.includes('2026'), 'in-scope year stays offered')
    assert.ok(!yearValues.includes('2027'), 'year existing only out of scope is not offered')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
