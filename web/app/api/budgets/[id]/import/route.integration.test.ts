import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetImportState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetImportState;
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
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

interface ImportFixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  subB: string
  subBName: string
  rootName: string
  accountNumber: string
  periodName: string
  scenarioId: string
}

async function fixture(): Promise<ImportFixture> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  state.allowed = null
  const sub = (await db.execute<{ id: string; name: string }>(
    sql`insert into subsidiaries (org_id, parent_id, name, base_currency, country)
        values (${org.orgId}, ${org.subsidiaryId}, 'Import Sub B', 'CAD', 'CA') returning id, name`,
  )).rows[0]!
  const rootName = (await db.execute<{ name: string }>(
    sql`select name from subsidiaries where id = ${org.subsidiaryId}`,
  )).rows[0]!.name
  const accountNumber = (await db.execute<{ number: string }>(
    sql`select number from accounts where id = ${org.accounts.cogs}`,
  )).rows[0]!.number
  const periodName = (await db.execute<{ name: string }>(
    sql`select name from accounting_periods where id = ${org.periodId}`,
  )).rows[0]!.name
  const fy = (await db.execute<{ fiscal_year: number }>(
    sql`select fiscal_year from accounting_periods where id = ${org.periodId}`,
  )).rows[0]!.fiscal_year
  const scenarioId = randomUUID()
  await db.execute(sql`
    insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
    values (${scenarioId}, ${org.orgId}, ${org.bookId}, ${fy}, 'Import Target', 'budget', 'draft')`)
  return { org, subB: sub.id, subBName: sub.name, rootName, accountNumber, periodName, scenarioId }
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })
async function post(id: string, body: unknown) {
  return withOrgContext(state.orgId, () => POST(
    new Request(`http://budget.test/api/budgets/${id}/import`, { method: 'POST', body: JSON.stringify(body) }),
    params(id),
  ))
}
async function revision(scenarioId: string, orgId: string) {
  return (await db.execute<{ revision: number }>(
    sql`select revision from budget_scenarios where id = ${scenarioId} and org_id = ${orgId}`,
  )).rows[0]!.revision
}
async function lines(scenarioId: string, orgId: string) {
  return (await db.execute<{ subsidiary: string; amount: string }>(
    sql`select s.name as subsidiary, bl.amount::text as amount
        from budget_lines bl join subsidiaries s on s.id = bl.subsidiary_id
        where bl.org_id = ${orgId} and bl.scenario_id = ${scenarioId} order by amount`,
  )).rows
}
function csv(rows: string[][]) {
  return rows.map((cells) => cells.map((c) => `"${c.replaceAll('"', '""')}"`).join(',')).join('\n')
}

test('import carries the subsidiary and the export round-trips it', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const text = csv([
      ['Account Number', 'Period', 'Subsidiary', 'Amount', 'Note'],
      [f.accountNumber, f.periodName, f.rootName, '100', 'root plan'],
      [f.accountNumber, f.periodName, f.subBName, '200', 'entity plan'],
    ])
    const dry = await post(f.scenarioId, { format: 'csv', text, expectedRevision: 1 })
    assert.equal(dry.status, 200)
    assert.equal((await dry.json() as { valid: boolean }).valid, true)
    const saved = await post(f.scenarioId, { format: 'csv', text, expectedRevision: 1, commit: true })
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()))
    assert.equal(await revision(f.scenarioId, f.org.orgId), 2)
    assert.deepEqual(await lines(f.scenarioId, f.org.orgId), [
      { subsidiary: f.rootName, amount: '100.0000' },
      { subsidiary: f.subBName, amount: '200.0000' },
    ])
  } finally {
    state.allowed = null
    await dropScratchOrg(f.org.orgId)
  }
})

test('a zero-amount row clears only its own entity cell', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await db.execute(sql`
      insert into budget_lines (org_id, scenario_id, account_id, period_id, subsidiary_id, amount)
      values (${f.org.orgId}, ${f.scenarioId}, ${f.org.accounts.cogs}, ${f.org.periodId}, ${f.org.subsidiaryId}, '100'),
             (${f.org.orgId}, ${f.scenarioId}, ${f.org.accounts.cogs}, ${f.org.periodId}, ${f.subB}, '200')`)
    const text = csv([
      ['Account Number', 'Period', 'Subsidiary', 'Amount'],
      [f.accountNumber, f.periodName, f.rootName, '0'],
    ])
    const saved = await post(f.scenarioId, { format: 'csv', text, expectedRevision: 1, commit: true })
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()))
    // Before the entity fix the delete matched every subsidiary: both cells
    // were wiped. Now the hidden-entity line must survive untouched.
    assert.deepEqual(await lines(f.scenarioId, f.org.orgId), [
      { subsidiary: f.subBName, amount: '200.0000' },
    ])
  } finally {
    state.allowed = null
    await dropScratchOrg(f.org.orgId)
  }
})

test('a legacy file without a subsidiary column lands in the root', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const text = csv([
      ['Account Number', 'Period', 'Amount'],
      [f.accountNumber, f.periodName, '50'],
    ])
    const saved = await post(f.scenarioId, { format: 'csv', text, expectedRevision: 1, commit: true })
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()))
    assert.deepEqual(await lines(f.scenarioId, f.org.orgId), [
      { subsidiary: f.rootName, amount: '50.0000' },
    ])
  } finally {
    state.allowed = null
    await dropScratchOrg(f.org.orgId)
  }
})

test('an out-of-scope subsidiary is rejected before any write', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    state.allowed = new Set([f.org.subsidiaryId])
    const text = csv([
      ['Account Number', 'Period', 'Subsidiary', 'Amount'],
      [f.accountNumber, f.periodName, f.subBName, '200'],
    ])
    const refused = await post(f.scenarioId, { format: 'csv', text, expectedRevision: 1, commit: true })
    assert.equal(refused.status, 200)
    const payload = await refused.json() as { valid: boolean; errors: { field: string; message: string }[] }
    assert.equal(payload.valid, false)
    assert.ok(payload.errors.some((e) => e.field === 'Subsidiary' && e.message === 'invalid_subsidiary'))
    assert.deepEqual(await lines(f.scenarioId, f.org.orgId), [])
    assert.equal(await revision(f.scenarioId, f.org.orgId), 1)
  } finally {
    state.allowed = null
    await dropScratchOrg(f.org.orgId)
  }
})


test('subsidiary names round-trip exactly and ambiguous folded names refuse', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    await db.execute(sql`update subsidiaries set name='Case Company' where id=${f.subB} and org_id=${f.org.orgId}`)
    await db.execute(sql`insert into subsidiaries(org_id,parent_id,name,base_currency,country)
      values (${f.org.orgId},${f.org.subsidiaryId},'case company','CAD','CA')`)
    const exact = await post(f.scenarioId, { format:'csv', text:csv([
      ['Account Number','Period','Subsidiary','Amount'],
      [f.accountNumber,f.periodName,'Case Company','12'],
    ]), expectedRevision:1, commit:true })
    assert.equal(exact.status,200)
    assert.deepEqual(await lines(f.scenarioId,f.org.orgId),[{subsidiary:'Case Company',amount:'12.0000'}])
    const before = await revision(f.scenarioId,f.org.orgId)
    const ambiguous = await post(f.scenarioId, { format:'csv', text:csv([
      ['Account Number','Period','Subsidiary','Amount'],
      [f.accountNumber,f.periodName,'CASE COMPANY','99'],
    ]), expectedRevision:before, commit:true })
    const payload = await ambiguous.json() as {valid:boolean;errors:{message:string}[]}
    assert.equal(payload.valid,false)
    assert.ok(payload.errors.some(e=>e.message==='ambiguous_subsidiary'))
    assert.equal(await revision(f.scenarioId,f.org.orgId),before)
    assert.deepEqual(await lines(f.scenarioId,f.org.orgId),[{subsidiary:'Case Company',amount:'12.0000'}])
  } finally { state.allowed=null; await dropScratchOrg(f.org.orgId) }
})
