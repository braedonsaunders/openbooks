import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Two subsidiaries budgeting the same account/period used to collapse into
// one worksheet input (keyed by account|period): one line hid, and an edit
// queued no subsidiary — overwriting the root line while the hidden entity
// lines still counted in totals. The worksheet is one entity slice (the
// value identity carries subsidiaryId end to end), defaulting to the tenant
// root like the import, the save path and the storage trigger.

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
const { saveBudgetCells } = await import('./budget-mutations.ts')

const DB = !!process.env.OPENBOOKS_DB_URL
const DIMS = { departmentId: null, projectId: null, locationId: null, classId: null }

test('two subsidiaries on the same account and period stay distinct cells', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const subB = (await db.execute<{ id: string }>(sql`
      insert into subsidiaries (org_id, parent_id, name, base_currency, country)
      values (${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA') returning id`)).rows[0]!.id
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Entity Slice', 'budget', 'draft')`)
    for (const [sub, amount] of [[org.subsidiaryId, '100.0000'], [subB, '200.0000']] as const) {
      await db.execute(sql`
        insert into budget_lines
          (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
        values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${sub},
                ${amount}, ${randomUUID()}, ${randomUUID()})`)
    }

    // Default slice: the tenant root only, never a collapsed merge.
    const rootSlice = await loadBudgetWorkspace(scenarioId, org.orgId, {
      page: 1, perPage: 50, dims: { ...DIMS, subsidiaryId: null },
    })
    assert.ok(rootSlice, 'the root slice loads')
    assert.equal(rootSlice.effectiveSubsidiaryId, org.subsidiaryId)
    assert.equal(rootSlice.lines.length, 1, 'the root slice carries exactly the root line')
    assert.equal(rootSlice.lines[0]!.subsidiaryId, org.subsidiaryId)
    assert.equal(rootSlice.lines[0]!.amount, '100.0000')
    assert.equal(rootSlice.sliceTotal, '100.0000')

    // Entity B slice: only B's line.
    const bSlice = await loadBudgetWorkspace(scenarioId, org.orgId, {
      page: 1, perPage: 50, dims: { ...DIMS, subsidiaryId: subB },
    })
    assert.ok(bSlice, 'the entity slice loads')
    assert.equal(bSlice.effectiveSubsidiaryId, subB)
    assert.equal(bSlice.lines.length, 1)
    assert.equal(bSlice.lines[0]!.subsidiaryId, subB)
    assert.equal(bSlice.lines[0]!.amount, '200.0000')
    assert.equal(bSlice.sliceTotal, '200.0000')

    // An edit naming entity B rewrites B's line — never the root line.
    const saved = await saveBudgetCells({
      scenarioId, orgId: org.orgId, actorId: randomUUID(), expectedRevision: 1,
      cells: [{
        accountId: org.accounts.cogs, periodId: org.periodId, subsidiaryId: subB,
        departmentId: null, projectId: null, locationId: null, classId: null,
        amount: '250.0000',
      }],
    })
    assert.equal(saved.revision, 2)
    const amounts = (await db.execute<{ subsidiary_id: string; amount: string }>(sql`
      select subsidiary_id, amount::text as amount from budget_lines
       where scenario_id = ${scenarioId} and org_id = ${org.orgId}`)).rows
    assert.deepEqual(
      new Map(amounts.map((r) => [r.subsidiary_id, r.amount])),
      new Map([[org.subsidiaryId, '100.0000'], [subB, '250.0000']]),
      "editing B's cell leaves the root line untouched",
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
