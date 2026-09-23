import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * OM-05: opening New budgets nothing. The unsaved-create workspace must be
 * the same worksheet slice the persisted drawer edits (same periods,
 * accounts, dimensions) bound to an in-memory scenario — and loading it
 * must not insert any budget_scenarios row. The drawer's explicit Save is
 * the first write; abandoning the drawer leaves no row behind.
 */

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
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
  const org = await createScratchOrg()
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
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${fy}, 'Parity Probe', 'budget', 'draft')`)
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
  const org = await createScratchOrg()
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
