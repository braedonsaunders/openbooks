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


const budgetCalendarCases = [
  { label: "budget calendar pin", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const { registerHooks } = await import('node:module');
        const test = (await import('node:test')).default;
        // A budget is pinned to ONE calendar — the org default. The line guard used
        // to admit non-adjustment periods from any calendar while the worksheet
        // showed default-calendar periods only: a line on a second calendar was
        // hidden from the worksheet but counted in totals. The guard now refuses
        // non-default periods, and the worksheet, its lines and its totals all read
        // the default set.

        registerHooks({
          resolve(specifier, _context, next) {
            return next(specifier)
          },
        })

        const { sql } = await import('drizzle-orm')
        const { db } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { loadBudgetWorkspace } = await import('./budgets.ts')
        const { saveBudgetCells, BudgetMutationError } = await import('./budget-mutations.ts')

        const DB = !!process.env.OPENBOOKS_DB_URL
        const DIMS = { subsidiaryId: null, departmentId: null, projectId: null, locationId: null, classId: null }

        async function secondCalendarPeriod(orgId: string, calendarId: string) {
          return withBypassContext(async () => {
          const otherCalendar = randomUUID()
          assert.notEqual(otherCalendar, calendarId, 'the second calendar must differ from the budget default')
          const createdCalendar = await db.execute<{ id: string }>(sql`
            insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                          adjustment_period_enabled, is_default, is_active, config)
            values (${otherCalendar}, ${orgId}, 'Retail', 'monthly', 1, 1, 'UTC', false, false, true, '{}'::jsonb) returning id`)
          assert.deepEqual(createdCalendar.rows.map(row => row.id), [otherCalendar], 'second fiscal calendar is stored')
          const otherPeriod = randomUUID()
          const createdPeriod = await db.execute<{ id: string }>(sql`
            insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
            values (${otherPeriod}, ${orgId}, 2026, 7, '2026-07R', '2026-07-01', '2026-07-31', false, ${otherCalendar}) returning id`)
          assert.deepEqual(createdPeriod.rows.map(row => row.id), [otherPeriod], 'second fiscal calendar period is stored')
          return otherPeriod
          })
        }

        test('the line guard refuses a period off the default calendar', { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const calendarId = (await db.execute<{ id: string }>(sql`
              select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
            const otherPeriod = await secondCalendarPeriod(org.orgId, calendarId)
            const scenarioId = randomUUID()
            const scenario = await withBypassContext(() => db.execute<{ id: string }>(sql`
              insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
              values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Calendar Target', 'budget', 'draft') returning id`))
            assert.deepEqual(scenario.rows.map(row => row.id), [scenarioId], 'calendar refusal scenario is stored')
            await assert.rejects(
              withOrgContext(org.orgId, () => db.execute(sql`
                insert into budget_lines
                  (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
                values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${otherPeriod}, ${org.subsidiaryId},
                        '100.0000', ${randomUUID()}, ${randomUUID()})`)),
              (error: unknown) => {
                let current: unknown = error
                while (current instanceof Error) {
                  if (/default fiscal calendar/.test(current.message)) return true
                  current = (current as Error & { cause?: unknown }).cause
                }
                return false
              },
              'a line on a non-default calendar is refused by the trigger',
            )
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test('the worksheet save refuses a period off the default calendar', { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const calendarId = (await db.execute<{ id: string }>(sql`
              select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
            const otherPeriod = await secondCalendarPeriod(org.orgId, calendarId)
            const scenarioId = randomUUID()
            const scenario = await withBypassContext(() => db.execute<{ id: string }>(sql`
              insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
              values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Calendar Save', 'budget', 'draft') returning id`))
            assert.deepEqual(scenario.rows.map(row => row.id), [scenarioId], 'worksheet refusal scenario is stored')
            await assert.rejects(
              withOrgContext(org.orgId, () => saveBudgetCells({
                scenarioId,
                orgId: org.orgId,
                actorId: randomUUID(),
                expectedRevision: 1,
                cells: [{
                  accountId: org.accounts.cogs,
                  periodId: otherPeriod,
                  subsidiaryId: org.subsidiaryId,
                  departmentId: null,
                  projectId: null,
                  locationId: null,
                  classId: null,
                  amount: '100.0000',
                }],
              })),
              (error: unknown) => error instanceof BudgetMutationError && error.message === 'invalid_period',
              'saving a cell on a non-default calendar period is refused',
            )
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test('worksheet, lines and totals read the default calendar set only', { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const calendarId = (await db.execute<{ id: string }>(sql`
              select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
            const otherPeriod = await secondCalendarPeriod(org.orgId, calendarId)
            const scenarioId = randomUUID()
            const scenario = await withBypassContext(() => db.execute<{ id: string }>(sql`
              insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
              values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Calendar Target', 'budget', 'draft') returning id`))
            assert.deepEqual(scenario.rows.map(row => row.id), [scenarioId], 'default-calendar worksheet scenario is stored')
            await withBypassContext(() => db.execute(sql`
              insert into budget_lines
                (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
              values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId},
                      '100.0000', ${randomUUID()}, ${randomUUID()})`))
            // A legacy line predating the pin (written while the guard was off):
            // it must be invisible to the worksheet, not hidden-yet-counted.
            await withBypassContext(() => db.execute(sql`alter table public.budget_lines disable trigger budget_line_guard`))
            try {
              await withBypassContext(() => db.execute(sql`
                insert into budget_lines
                  (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
                values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${otherPeriod}, ${org.subsidiaryId},
                        '900.0000', ${randomUUID()}, ${randomUUID()})`))
            } finally {
              await withBypassContext(() => db.execute(sql`alter table public.budget_lines enable trigger budget_line_guard`))
            }

            const workspace = await loadBudgetWorkspace(scenarioId, org.orgId, { page: 1, perPage: 50, dims: DIMS })
            assert.ok(workspace, 'the workspace loads')
            assert.deepEqual(
              workspace.periods.map((p) => p.id),
              [org.periodId],
              'the worksheet lists default-calendar periods only',
            )
            assert.equal(workspace.lines.length, 1, 'only the default-calendar line is returned')
            assert.equal(workspace.lines[0]!.amount, '100.0000')
            assert.equal(workspace.sliceTotal, '100.0000', 'the total counts the same set the worksheet shows')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "budget export calendar", register: async () => {
        const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        const ExcelJS = (await import("exceljs")).default;
        const { sql } = await import("drizzle-orm");
        // The budget xlsx export stamps the workbook's created/modified properties
        // from the org business day. The route, the scenario query, the
        // business-day clock, and the office xlsx writer are real; only the
        // feature/permission gate is seammed.
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier.endsWith("/lib/authz")) {
              return { shortCircuit: true, url: "mock:budget-export-gate" };
            }
            if (specifier.endsWith("/lib/feature-gates")) {
              return { shortCircuit: true, url: "mock:budget-export-features" };
            }
            return nextResolve(specifier, context);
          },
          load(url, context, nextLoad) {
            if (url === "mock:budget-export-gate") {
              return {
                format: "module",
                shortCircuit: true,
                source: `import { permissionSetCovers } from '${enginePermissionsUrl}'
                  export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }`,
              };
            }
            if (url === "mock:budget-export-features") {
              return {
                format: "module",
                shortCircuit: true,
                source: `const key = Symbol.for('openbooks.budget-export-gate')
                  export async function guardFeaturePermission() { return globalThis[key] }`,
              };
            }
            return nextLoad(url, context);
          },
        });

        const gateKey = Symbol.for("openbooks.budget-export-gate");
        const enginePermissionsUrl = new URL(
          "../../engine/src/organization/permissions.ts",
          import.meta.url,
        ).href;
        const { db, withBypassContext: withBypass } = await import(
          "@openbooks/engine/src/platform/db.ts"
        );
        const { createScratchOrg, dropScratchOrg } = await import(
          "@openbooks/engine/src/testing/fixtures.ts"
        );
        const { businessToday } = await import("@openbooks/engine/src/platform/business-date.ts");
        const { GET } = await import("../app/api/budgets/[id]/export/route.ts");

        test("the budget xlsx stamps the workbook from the org business day", async () => {
          const scratch = await withBypass(() => createScratchOrg());
          try {
            (globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
              user: { id: "budget-export-test", orgId: scratch.orgId },
              permissions: new Set(["budgets.read", "data.export"]),
              allowedSubsidiaryIds: null,
            };
            const scenarioId = randomUUID();
            const accountId = randomUUID();
            await withBypass(async () => {
              await db.execute(sql`
                insert into accounts (id, org_id, number, name, type, is_summary, is_active)
                values (${accountId}, ${scratch.orgId}, 'BXE-1', 'Export budget account', 'expense', false, true)
              `);
              await db.execute(sql`
                insert into budget_scenarios (id, org_id, book_id, fiscal_year, name)
                values (${scenarioId}, ${scratch.orgId}, ${scratch.bookId}, 2026, 'Export calendar budget')
              `);
              await db.execute(sql`
                insert into budget_lines (org_id, scenario_id, account_id, period_id, amount)
                values (${scratch.orgId}, ${scenarioId}, ${accountId}, ${scratch.periodId}, '5000.0000')
              `);
            });
            const stamp = await withBypass(() => businessToday(scratch.orgId));

            const response = await GET(
              new Request(`http://openbooks.test/api/budgets/${scenarioId}/export?format=xlsx`),
              { params: Promise.resolve({ id: scenarioId }) },
            );
            assert.equal(response.status, 200);
            const disposition = response.headers.get("content-disposition") ?? "";
            assert.ok(disposition.includes(stamp), "the download filename names the business day");

            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer);
            for (const property of [workbook.created, workbook.modified] as const) {
              assert.ok(property instanceof Date, "workbook properties arrive as dates");
              assert.equal(property.toISOString().slice(0, 10), stamp);
            }
          } finally {
            await withBypass(() => dropScratchOrg(scratch.orgId));
          }
        });
  } },
  { label: "budget presentation", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const { registerHooks } = await import('node:module');
        const test = (await import('node:test')).default;
        registerHooks({
          resolve(specifier, _context, next) {
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
         * The budget tree keeps the rolled presentation (this reader keeps rolled
         * rows), so its section totals must sum depth-0 rows only: a nested expense
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
  } },
  { label: "budget subsidiary slice", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const { registerHooks } = await import('node:module');
        const test = (await import('node:test')).default;
        // Two subsidiaries budgeting the same account/period used to collapse into
        // one worksheet input (keyed by account|period): one line hid, and an edit
        // queued no subsidiary — overwriting the root line while the hidden entity
        // lines still counted in totals. The worksheet is one entity slice (the
        // value identity carries subsidiaryId end to end), defaulting to the tenant
        // root like the import, the save path and the storage trigger.

        registerHooks({
          resolve(specifier, _context, next) {
            return next(specifier)
          },
        })

        const { sql } = await import('drizzle-orm')
        const { db } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { loadBudgetWorkspace } = await import('./budgets.ts')
        const { saveBudgetCells } = await import('./budget-mutations.ts')

        const DB = !!process.env.OPENBOOKS_DB_URL
        const DIMS = { departmentId: null, projectId: null, locationId: null, classId: null }

        test('two subsidiaries on the same account and period stay distinct cells', { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const subsidiary = await withBypassContext(() => db.execute<{ id: string }>(sql`
              insert into subsidiaries (org_id, parent_id, name, base_currency, country)
              values (${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA') returning id`))
            assert.equal(subsidiary.rows.length, 1, 'entity-slice fixture creates one subsidiary')
            const subB = subsidiary.rows[0]!.id
            const scenarioId = randomUUID()
            await withBypassContext(async () => {
            const scenario = await db.execute<{ id: string }>(sql`
              insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
              values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Entity Slice', 'budget', 'draft') returning id`)
            assert.deepEqual(scenario.rows.map(row => row.id), [scenarioId], 'entity-slice scenario is stored')
            for (const [sub, amount] of [[org.subsidiaryId, '100.0000'], [subB, '200.0000']] as const) {
              const line = await db.execute<{ subsidiary_id: string }>(sql`
                insert into budget_lines
                  (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
                values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${sub},
                        ${amount}, ${randomUUID()}, ${randomUUID()}) returning subsidiary_id`)
              assert.deepEqual(line.rows.map(row => row.subsidiary_id), [sub], 'entity-slice line is stored for its subsidiary')
            }
            })

            // Default slice: the tenant root only, never a collapsed merge.
            const rootSlice = await withOrgContext(org.orgId, () => loadBudgetWorkspace(scenarioId, org.orgId, {
              page: 1, perPage: 50, dims: { ...DIMS, subsidiaryId: null },
            }))
            assert.ok(rootSlice, 'the root slice loads')
            assert.equal(rootSlice.effectiveSubsidiaryId, org.subsidiaryId)
            assert.equal(rootSlice.lines.length, 1, 'the root slice carries exactly the root line')
            assert.equal(rootSlice.lines[0]!.subsidiaryId, org.subsidiaryId)
            assert.equal(rootSlice.lines[0]!.amount, '100.0000')
            assert.equal(rootSlice.sliceTotal, '100.0000')

            // Entity B slice: only B's line.
            const bSlice = await withOrgContext(org.orgId, () => loadBudgetWorkspace(scenarioId, org.orgId, {
              page: 1, perPage: 50, dims: { ...DIMS, subsidiaryId: subB },
            }))
            assert.ok(bSlice, 'the entity slice loads')
            assert.equal(bSlice.effectiveSubsidiaryId, subB)
            assert.equal(bSlice.lines.length, 1)
            assert.equal(bSlice.lines[0]!.subsidiaryId, subB)
            assert.equal(bSlice.lines[0]!.amount, '200.0000')
            assert.equal(bSlice.sliceTotal, '200.0000')

            // An edit naming entity B rewrites B's line — never the root line.
            const saved = await withOrgContext(org.orgId, () => saveBudgetCells({
              scenarioId, orgId: org.orgId, actorId: randomUUID(), expectedRevision: 1,
              cells: [{
                accountId: org.accounts.cogs, periodId: org.periodId, subsidiaryId: subB,
                departmentId: null, projectId: null, locationId: null, classId: null,
                amount: '250.0000',
              }],
            }))
            assert.equal(saved.revision, 2)
            const amounts = (await withOrgContext(org.orgId, () => db.execute<{ subsidiary_id: string; amount: string }>(sql`
              select subsidiary_id, amount::text as amount from budget_lines
               where scenario_id = ${scenarioId} and org_id = ${org.orgId}`))).rows
            assert.deepEqual(
              new Map(amounts.map((r) => [r.subsidiary_id, r.amount])),
              new Map([[org.subsidiaryId, '100.0000'], [subB, '250.0000']]),
              "editing B's cell leaves the root line untouched",
            )
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
  { label: "budgets source options", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const { registerHooks } = await import('node:module');
        const test = (await import('node:test')).default;
        registerHooks({ resolve(specifier, _context, next) {
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
  } },
  { label: "budgets unsaved", register: async () => {
        const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
        const { randomUUID } = await import('node:crypto');
        const { registerHooks } = await import('node:module');
        const test = (await import('node:test')).default;
        /**
         * Opening New budgets nothing. The unsaved-create workspace must be
         * the same worksheet slice the persisted drawer edits (same periods,
         * accounts, dimensions) bound to an in-memory scenario — and loading it
         * must not insert any budget_scenarios row. The drawer's explicit Save is
         * the first write; abandoning the drawer leaves no row behind.
         */

        registerHooks({
          resolve(specifier, _context, next) {
            return next(specifier)
          },
        })

        const { sql } = await import('drizzle-orm')
        const { db } = await import('@openbooks/engine/src/platform/db.ts')
        const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { BudgetPrerequisiteError, loadBudgetWorkspace, loadUnsavedBudgetWorkspace } = await import('./budgets.ts')

        const DB = !!process.env.OPENBOOKS_DB_URL
        const DIMS = { subsidiaryId: null, departmentId: null, projectId: null, locationId: null, classId: null }

        async function scenarioCount(orgId: string): Promise<number> {
          return (await db.execute<{ n: number }>(sql`
            select count(*)::int as n from budget_scenarios where org_id = ${orgId}`)).rows[0]!.n
        }

        test('loading the unsaved workspace writes nothing and mirrors the persisted sheet', { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const fy = (await db.execute<{ fiscal_year: number }>(sql`
              select fiscal_year from accounting_periods where id = ${org.periodId}`)).rows[0]!.fiscal_year
            const before = await scenarioCount(org.orgId)

            const unsaved = await loadUnsavedBudgetWorkspace(org.orgId, {
              page: 1,
              perPage: 50,
              dims: DIMS,
              fiscalYear: fy,
            })

            assert.equal(unsaved.scenario.id, '', 'unsaved scenario carries no id')
            assert.equal(unsaved.scenario.status, 'draft')
            assert.deepEqual(unsaved.lines, [], 'unsaved workspace carries no lines')
            assert.equal(unsaved.sliceTotal, '0.0000')
            assert.ok(unsaved.periods.length > 0, 'worksheet periods load without a scenario')
            assert.ok(unsaved.accounts.length > 0, 'worksheet accounts load without a scenario')
            assert.equal(
              await scenarioCount(org.orgId),
              before,
              'opening New must not insert a budget row — the explicit Save is the first write',
            )

            // Same sheet as the persisted drawer: one saved scenario loads identical
            // periods and the same account page for the same slice.
            const scenarioId = randomUUID()
            const scenario = await withBypassContext(() => db.execute<{ id: string }>(sql`
              insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
              values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${fy}, 'Parity Probe', 'budget', 'draft') returning id`))
            assert.deepEqual(scenario.rows.map(row => row.id), [scenarioId], 'unsaved-workspace parity scenario is stored')
            const persisted = await loadBudgetWorkspace(scenarioId, org.orgId, {
              page: 1,
              perPage: 50,
              dims: DIMS,
            })
            assert.deepEqual(
              unsaved.periods.map((p) => p.id),
              persisted!.periods.map((p) => p.id),
              'unsaved and persisted drawers read the same periods',
            )
            assert.deepEqual(
              unsaved.accounts.map((a) => a.id),
              persisted!.accounts.map((a) => a.id),
              'unsaved and persisted drawers read the same account page',
            )
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })

        test('the unsaved workspace refuses an unknown book instead of defaulting', { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const before = await scenarioCount(org.orgId)
            await assert.rejects(
              loadUnsavedBudgetWorkspace(org.orgId, {
                page: 1,
                perPage: 50,
                dims: DIMS,
                bookId: randomUUID(),
              }),
              (error: unknown) => {
                assert.ok(error instanceof BudgetPrerequisiteError)
                assert.equal(error.message, 'invalid_book_or_fiscal_year')
                return true
              },
            )
            assert.equal(await scenarioCount(org.orgId), before, 'a refused open must not write anything')
          } finally {
            await dropScratchOrg(org.orgId)
          }
        })
  } },
] as const;

for (const row of budgetCalendarCases) await row.register();
