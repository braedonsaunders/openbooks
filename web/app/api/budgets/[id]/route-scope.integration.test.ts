import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Reinterpreting a plan against a different ledger silently reprices it: the
// route refused fiscal-year changes with lines present but allowed book
// changes. Both now refuse with budget_scope_has_lines, and the scenario
// trigger enforces the same rule for writers bypassing the route.

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __budgetScopeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetScopeState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function secondBook(orgId: string): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into accounting_books (id, org_id, code, name, is_primary, is_active)
    values (${id}, ${orgId}, 'SECOND', 'Second book', false, true)`)
  return id
}

test('PATCH refuses a book change once the budget has lines', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  try {
    const otherBook = await secondBook(org.orgId)
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Scope Target', 'budget', 'draft')`)
    await db.execute(sql`
      insert into budget_lines
        (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId},
              '100.0000', ${state.actorId}, ${state.actorId})`)

    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://budget.test/api/budgets/${scenarioId}`, {
        method: 'PATCH',
        body: JSON.stringify({ bookId: otherBook, expectedRevision: 1 }),
      }),
      { params: Promise.resolve({ id: scenarioId }) },
    ))
    const body = (await response.json()) as { error?: string }
    assert.equal(response.status, 409)
    assert.equal(body.error, 'budget_scope_has_lines')

    const scenario = (await db.execute<{ book_id: string; revision: number }>(sql`
      select book_id, revision from budget_scenarios where id = ${scenarioId} and org_id = ${org.orgId}`)).rows[0]!
    assert.equal(scenario.book_id, org.bookId, 'the book is unchanged')
    assert.equal(scenario.revision, 1, 'the revision is unchanged')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still allows a book change before any line exists', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  try {
    const otherBook = await secondBook(org.orgId)
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Empty Scope', 'budget', 'draft')`)

    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://budget.test/api/budgets/${scenarioId}`, {
        method: 'PATCH',
        body: JSON.stringify({ bookId: otherBook, expectedRevision: 1 }),
      }),
      { params: Promise.resolve({ id: scenarioId }) },
    ))
    assert.equal(response.status, 200, `line-less book change must succeed: ${JSON.stringify(await response.json())}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('the scenario trigger refuses a book change under lines for direct writers', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    const otherBook = await secondBook(org.orgId)
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Trigger Scope', 'budget', 'draft')`)
    await db.execute(sql`
      insert into budget_lines
        (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId},
              '100.0000', ${randomUUID()}, ${randomUUID()})`)
    await assert.rejects(
      db.execute(sql`
        update budget_scenarios set book_id = ${otherBook}, revision = revision + 1
         where id = ${scenarioId} and org_id = ${org.orgId}`),
      (error: unknown) => {
        let current: unknown = error
        while (current instanceof Error) {
          if (/fixed once the budget has lines/.test(current.message)) return true
          current = (current as Error & { cause?: unknown }).cause
        }
        return false
      },
      'direct book changes under lines are refused by the trigger',
    )
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
