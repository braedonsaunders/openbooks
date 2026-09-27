import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * Budget vs actual resolved the WHOLE fiscal year with no period
 * bound, so a year-to-date view included future-dated actuals the P&L never
 * showed (cogs / expense residuals on the real tenant). The view now takes
 * the same caller-resolved window as every other statement, echoes it on the
 * Actual column, and its actuals equal the P&L's for the same range.
 */
const root = pathToFileURL(process.cwd() + '/').href
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


const consolidatedRows = [
  { label: "budget list subsidiary scope", register: async () => {
        const { sql }=await import("drizzle-orm");
        type ListViewConfig = import("@openbooks/customization").ListViewConfig;
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
  } },
] as const;

for(const row of consolidatedRows) await row.register();
