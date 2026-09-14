import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetExportState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetExportState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier === '../../../../../lib/authz') return virtual(`
      export function can() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { GET } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

test('budget export carries the legal entity per line', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    state.allowed = null
    const subB = (await db.execute<{ id: string; name: string }>(
      sql`insert into subsidiaries (org_id, parent_id, name, base_currency, country)
          values (${org.orgId}, ${org.subsidiaryId}, 'Export Sub B', 'CAD', 'CA') returning id, name`,
    )).rows[0]!
    const rootName = (await db.execute<{ name: string }>(
      sql`select name from subsidiaries where id = ${org.subsidiaryId}`,
    )).rows[0]!.name
    const fy = (await db.execute<{ fiscal_year: number }>(
      sql`select fiscal_year from accounting_periods where id = ${org.periodId}`,
    )).rows[0]!.fiscal_year
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${fy}, 'Export Source', 'budget', 'draft')`)
    await db.execute(sql`
      insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, '100'),
             (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${subB.id}, '200')`)
    const response = await withOrgContext(org.orgId, () => GET(
      new Request(`http://budget.test/api/budgets/${scenarioId}/export?format=csv`),
      { params: Promise.resolve({ id: scenarioId }) },
    ))
    assert.equal(response.status, 200)
    const text = await response.text()
    const [header, ...rows] = text.replace(/^\uFEFF/, '').trim().split('\n')
    assert.ok(header!.includes('Subsidiary'), `header carries Subsidiary: ${header}`)
    assert.equal(rows.length, 2)
    // An export without the entity column cannot round-trip through import:
    // each line must name exactly the subsidiary its amount was planned for.
    assert.ok(rows.some((r) => r.includes(rootName) && r.includes('100')), text)
    assert.ok(rows.some((r) => r.includes(subB.name) && r.includes('200')), text)
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})

test('budget export discloses only caller-visible entities', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const subB = (await db.execute<{ id: string; name: string }>(
      sql`insert into subsidiaries (org_id, parent_id, name, base_currency, country)
          values (${org.orgId}, ${org.subsidiaryId}, 'Hidden Export Sub', 'CAD', 'CA') returning id, name`,
    )).rows[0]!
    const fy = (await db.execute<{ fiscal_year: number }>(
      sql`select fiscal_year from accounting_periods where id = ${org.periodId}`,
    )).rows[0]!.fiscal_year
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${fy}, 'Scoped Export', 'budget', 'draft')`)
    await db.execute(sql`
      insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId}, '100'),
             (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${subB.id}, '200')`)
    // Before the gate predicate the export labelled every entity: a restricted
    // caller received hidden-entity lines alongside their own.
    state.allowed = new Set([org.subsidiaryId])
    const response = await withOrgContext(org.orgId, () => GET(
      new Request(`http://budget.test/api/budgets/${scenarioId}/export?format=csv`),
      { params: Promise.resolve({ id: scenarioId }) },
    ))
    assert.equal(response.status, 200)
    const text = await response.text()
    const [, ...rows] = text.replace(/^\uFEFF/, '').trim().split('\n')
    assert.equal(rows.length, 1)
    assert.ok(rows[0]!.includes('100'), text)
    assert.ok(!text.includes(subB.name), 'hidden entity must not appear in the export')
  } finally {
    state.allowed = null
    await dropScratchOrg(org.orgId)
  }
})
