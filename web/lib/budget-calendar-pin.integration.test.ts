import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// A budget is pinned to ONE calendar — the org default. The line guard used
// to admit non-adjustment periods from any calendar while the worksheet
// showed default-calendar periods only: a line on a second calendar was
// hidden from the worksheet but counted in totals. The guard now refuses
// non-default periods, and the worksheet, its lines and its totals all read
// the default set.

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
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
  const otherCalendar = randomUUID()
  assert.notEqual(otherCalendar, calendarId, 'the second calendar must differ from the budget default')
  await db.execute(sql`
    insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                  adjustment_period_enabled, is_default, is_active, config)
    values (${otherCalendar}, ${orgId}, 'Retail', 'monthly', 1, 1, 'UTC', false, false, true, '{}'::jsonb)`)
  const otherPeriod = randomUUID()
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${otherPeriod}, ${orgId}, 2026, 7, '2026-07R', '2026-07-01', '2026-07-31', false, ${otherCalendar})`)
  return otherPeriod
}

test('the line guard refuses a period off the default calendar', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const calendarId = (await db.execute<{ id: string }>(sql`
      select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
    const otherPeriod = await secondCalendarPeriod(org.orgId, calendarId)
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Calendar Target', 'budget', 'draft')`)
    await assert.rejects(
      db.execute(sql`
        insert into budget_lines
          (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
        values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${otherPeriod}, ${org.subsidiaryId},
                '100.0000', ${randomUUID()}, ${randomUUID()})`),
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
  const org = await createScratchOrg()
  try {
    const calendarId = (await db.execute<{ id: string }>(sql`
      select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
    const otherPeriod = await secondCalendarPeriod(org.orgId, calendarId)
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Calendar Save', 'budget', 'draft')`)
    await assert.rejects(
      saveBudgetCells({
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
      }),
      (error: unknown) => error instanceof BudgetMutationError && error.message === 'invalid_period',
      'saving a cell on a non-default calendar period is refused',
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('worksheet, lines and totals read the default calendar set only', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const calendarId = (await db.execute<{ id: string }>(sql`
      select fiscal_calendar_id as id from accounting_periods where id = ${org.periodId}`)).rows[0]!.id
    const otherPeriod = await secondCalendarPeriod(org.orgId, calendarId)
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Calendar Target', 'budget', 'draft')`)
    await db.execute(sql`
      insert into budget_lines
        (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId},
              '100.0000', ${randomUUID()}, ${randomUUID()})`)
    // A legacy line predating the pin (written while the guard was off):
    // it must be invisible to the worksheet, not hidden-yet-counted.
    await db.execute(sql`alter table public.budget_lines disable trigger budget_line_guard`)
    try {
      await db.execute(sql`
        insert into budget_lines
          (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
        values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${otherPeriod}, ${org.subsidiaryId},
                '900.0000', ${randomUUID()}, ${randomUUID()})`)
    } finally {
      await db.execute(sql`alter table public.budget_lines enable trigger budget_line_guard`)
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
