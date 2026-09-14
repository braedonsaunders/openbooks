import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetLinesState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetLinesState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier === '../../../../../lib/authz') return virtual(`
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
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

interface LinesFixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  scenarioId: string
  subB: string
}

async function fixture(): Promise<LinesFixture> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  state.allowed = null
  const subB = (await db.execute<{ id: string }>(
    sql`insert into subsidiaries (org_id, parent_id, name, base_currency, country)
        values (${org.orgId}, ${org.subsidiaryId}, 'Lines Sub B', 'CAD', 'CA') returning id`,
  )).rows[0]!.id
  const fy = (await db.execute<{ fiscal_year: number }>(
    sql`select fiscal_year from accounting_periods where id = ${org.periodId}`,
  )).rows[0]!.fiscal_year
  const scenarioId = randomUUID()
  await db.execute(sql`
    insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
    values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${fy}, 'Lines Subsidiary', 'budget', 'draft')`)
  return { org, scenarioId, subB }
}

async function patch(scenarioId: string, body: unknown) {
  return withOrgContext(state.orgId, () => PATCH(
    new Request(`http://budget.test/api/budgets/${scenarioId}/lines`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: scenarioId }) },
  ))
}

async function storedLines(scenarioId: string, orgId: string) {
  return (await db.execute<{ subsidiary_id: string; amount: string }>(
    sql`select subsidiary_id, amount::text as amount from budget_lines
        where org_id = ${orgId} and scenario_id = ${scenarioId} order by amount`,
  )).rows
}

test('lines PATCH honors an explicit subsidiaryId', { skip: !DB }, async () => {
  const { org, scenarioId, subB } = await fixture()
  try {
    const response = await patch(scenarioId, {
      expectedRevision: 1,
      cells: [{ accountId: org.accounts.cogs, periodId: org.periodId, subsidiaryId: subB, amount: '200' }],
    })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    // Before the fix the route dropped subsidiaryId and every cell landed on root.
    assert.deepEqual(await storedLines(scenarioId, org.orgId), [
      { subsidiary_id: subB, amount: '200.0000' },
    ])
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})

test('lines PATCH defaults an omitted subsidiary to the tenant root', { skip: !DB }, async () => {
  const { org, scenarioId } = await fixture()
  try {
    const response = await patch(scenarioId, {
      expectedRevision: 1,
      cells: [{ accountId: org.accounts.cogs, periodId: org.periodId, amount: '100' }],
    })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.deepEqual(await storedLines(scenarioId, org.orgId), [
      { subsidiary_id: org.subsidiaryId, amount: '100.0000' },
    ])
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})

test('lines PATCH rejects a subsidiary outside the caller scope', { skip: !DB }, async () => {
  const { org, scenarioId, subB } = await fixture()
  try {
    state.allowed = new Set([org.subsidiaryId])
    const response = await patch(scenarioId, {
      expectedRevision: 1,
      cells: [{ accountId: org.accounts.cogs, periodId: org.periodId, subsidiaryId: subB, amount: '200' }],
    })
    assert.equal(response.status, 422, JSON.stringify(await response.clone().json()))
    assert.equal((await response.json() as { error: string }).error, 'invalid_subsidiary')
    assert.deepEqual(await storedLines(scenarioId, org.orgId), [])
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})

test('lines PATCH rejects a root-defaulted cell when root is outside the caller scope', { skip: !DB }, async () => {
  const { org, scenarioId, subB } = await fixture()
  try {
    state.allowed = new Set([subB])
    const response = await patch(scenarioId, {
      expectedRevision: 1,
      cells: [{ accountId: org.accounts.cogs, periodId: org.periodId, amount: '100' }],
    })
    assert.equal(response.status, 422, JSON.stringify(await response.clone().json()))
    assert.equal((await response.json() as { error: string }).error, 'invalid_subsidiary')
    assert.deepEqual(await storedLines(scenarioId, org.orgId), [])
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})
