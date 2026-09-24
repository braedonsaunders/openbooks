import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Equipment GET checks the scope first, on the locked unit row, then answers
// the unit and its usage/revenue/cost aggregates from one snapshot: a
// concurrent unit rehome cannot authorize the unit and then move it before
// the metric reads of one response. Out-of-scope answers exactly like
// missing.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; scope: Set<string> | null } = { orgId: '', actorId: '', scope: null }
Object.assign(globalThis, { __equipmentScopeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__equipmentScopeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: s.scope };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET } = await import('./route.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

test('equipment GET answers an out-of-scope unit exactly like a missing one', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const hidden = randomUUID()
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`)
    const unit = async (number: string, subsidiaryId: string) =>
      (await db.execute<{ id: string }>(sql`
        insert into equipment_units (org_id, name, unit_number, status, subsidiary_id, purchase_price)
        values (${org.orgId}, ${number}, ${number}, 'draft', ${subsidiaryId}, '100.0000')
        returning id`)).rows[0]!.id
    const unitA = await unit('VIS-UNIT-1', org.subsidiaryId)
    const unitB = await unit('HID-UNIT-1', hidden)
    state.scope = new Set([org.subsidiaryId])
    const seen = await withOrgContext(org.orgId, () =>
      GET(new Request(`http://equipment.test/api/equipment/${unitA}`), { params: Promise.resolve({ id: unitA }) }))
    assert.equal(seen.status, 200, JSON.stringify(await seen.clone().json()))
    const concealed = await withOrgContext(org.orgId, () =>
      GET(new Request(`http://equipment.test/api/equipment/${unitB}`), { params: Promise.resolve({ id: unitB }) }))
    assert.equal(concealed.status, 404)
    assert.deepEqual(await concealed.json(), { error: 'not_found' })
  } finally {
    state.scope = null
    await dropScratchOrg(org.orgId)
  }
})

test('equipment GET waits on a unit rehome in flight instead of racing it', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  const writer = await pool.connect()
  let pending: Promise<Response> | undefined
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const hidden = randomUUID()
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`)
    const unitId = (await db.execute<{ id: string }>(sql`
      insert into equipment_units (org_id, name, unit_number, status, subsidiary_id, purchase_price)
      values (${org.orgId}, 'Moving unit', 'MOV-UNIT-1', 'draft', ${org.subsidiaryId}, '100.0000')
      returning id`)).rows[0]!.id
    state.scope = new Set([org.subsidiaryId])
    await writer.query('begin')
    await writer.query("select set_config('app.bypass_rls','on',true), set_config('statement_timeout','10000',true)")
    const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    await writer.query('update equipment_units set subsidiary_id=$1 where id=$2', [hidden, unitId])
    pending = withOrgContext(org.orgId, () =>
      GET(new Request(`http://equipment.test/api/equipment/${unitId}`), { params: Promise.resolve({ id: unitId }) }))
    let blocked = false
    for (let n = 0; n < 200; n++) {
      blocked = !!((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])).rowCount)
      if (blocked) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(blocked, 'the detail waits on the locked unit instead of reading the pre-rehome row')
    await writer.query('commit')
    const response = await pending
    assert.equal(response.status, 404, JSON.stringify(await response.clone().json()))
  } finally {
    await writer.query('rollback').catch(() => {})
    await pending?.catch(() => {})
    writer.release()
    state.scope = null
    await dropScratchOrg(org.orgId)
  }
})
