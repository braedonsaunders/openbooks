import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetDraftState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetDraftState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier === '../../../../lib/authz') return virtual(`
      export function subsidiariesInScope(gate, ids) {
        const scope = gate.allowedSubsidiaryIds;
        if (scope === null) return true;
        return ids.every((id) => id !== null && id !== undefined && id !== '' && scope.has(id));
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

interface DraftFixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  fy: number
  subB: string
  sourceId: string
}

async function fixture(): Promise<DraftFixture> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  state.allowed = null
  const fy = (await db.execute<{ fiscal_year: number }>(
    sql`select fiscal_year from accounting_periods where id = ${org.periodId}`,
  )).rows[0]!.fiscal_year
  const subB = (await db.execute<{ id: string }>(
    sql`insert into subsidiaries (org_id, parent_id, name, base_currency, country)
        values (${org.orgId}, ${org.subsidiaryId}, 'Draft Copy Sub B', 'CAD', 'CA') returning id`,
  )).rows[0]!.id
  const sourceId = randomUUID()
  await db.execute(sql`
    insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
    values (${sourceId}, ${org.orgId}, ${org.bookId}, ${fy}, 'Draft Copy Source', 'budget', 'draft')`)
  await db.execute(sql`
    insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
    values (${org.orgId}, ${sourceId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, '100'),
           (${org.orgId}, ${sourceId}, ${org.accounts.cogs}, ${org.periodId}, ${subB}, '200')`)
  return { org, fy, subB, sourceId }
}

async function post(body: unknown) {
  return withOrgContext(state.orgId, () => POST(
    new Request('http://budget.test/api/budgets/draft', { method: 'POST', body: JSON.stringify(body) }),
  ))
}

async function copiedLines(scenarioId: string, orgId: string) {
  return (await db.execute<{ subsidiary_id: string; amount: string }>(
    sql`select subsidiary_id, amount::text as amount from budget_lines
        where org_id = ${orgId} and scenario_id = ${scenarioId} order by amount`,
  )).rows
}

test('draft from source preserves each line legal entity', { skip: !DB }, async () => {
  const { org, fy, subB, sourceId } = await fixture()
  try {
    const response = await post({ bookId: org.bookId, fiscalYear: fy, sourceScenarioId: sourceId })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const targetId = (await response.json() as { id: string }).id
    // Before the entity fix this copy died with 23505 on budget_lines_cell:
    // both source lines were rehomed to the root by the storage trigger.
    assert.deepEqual(await copiedLines(targetId, org.orgId), [
      { subsidiary_id: org.subsidiaryId, amount: '100.0000' },
      { subsidiary_id: subB, amount: '200.0000' },
    ])
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})

test('draft from source copies only caller-visible entities', { skip: !DB }, async () => {
  const { org, fy, sourceId } = await fixture()
  try {
    state.allowed = new Set([org.subsidiaryId])
    const response = await post({ bookId: org.bookId, fiscalYear: fy, sourceScenarioId: sourceId })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const targetId = (await response.json() as { id: string }).id
    assert.deepEqual(await copiedLines(targetId, org.orgId), [
      { subsidiary_id: org.subsidiaryId, amount: '100.0000' },
    ])
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})

test('draft creation rejects a malformed explicit book id instead of defaulting', { skip: !DB }, async () => {
  const { org, fy } = await fixture()
  try {
    const before = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from budget_scenarios where org_id = ${org.orgId}`)).rows[0]!.n
    const response = await post({ bookId: 'not-a-uuid', fiscalYear: fy })
    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), { error: 'invalid_book_id' })
    const after = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from budget_scenarios where org_id = ${org.orgId}`)).rows[0]!.n
    assert.equal(after, before, 'malformed book input must not create a default-book draft')
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})

test('draft creation rejects a malformed source scenario id instead of creating blank', { skip: !DB }, async () => {
  const { org, fy } = await fixture()
  try {
    const before = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from budget_scenarios where org_id = ${org.orgId}`)).rows[0]!.n
    const response = await post({ bookId: org.bookId, fiscalYear: fy, sourceScenarioId: 'not-a-uuid' })
    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), { error: 'invalid_source_scenario_id' })
    const after = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from budget_scenarios where org_id = ${org.orgId}`)).rows[0]!.n
    assert.equal(after, before, 'malformed source input must not create a blank draft')
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})
