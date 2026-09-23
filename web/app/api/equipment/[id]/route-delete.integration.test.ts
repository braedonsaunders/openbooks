import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Equipment DELETE verified draft status outside its transaction and deleted
// by id/org only, so a concurrent activation was deleted and the stale
// draft audit recorded success. DELETE now checks status under the row
// lock, repeats the status in the delete predicate, and proves the write
// with the affected-row count instead of auditing a stale success.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __equipmentConcurrencyState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__equipmentConcurrencyState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { DELETE } = await import('./route.ts')

async function fixture(status = 'draft') {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const unitId = (await db.execute<{ id: string }>(sql`
    insert into equipment_units (org_id, name, unit_number, status, subsidiary_id, purchase_price)
    values (${org.orgId}, 'Test Unit', 'TEST-001', ${status}, ${org.subsidiaryId}, '100.0000')
    returning id`)).rows[0]!.id
  return { org, unitId }
}

async function call(id: string): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const response: Response = await withOrgContext(state.orgId, () =>
      DELETE(
        new Request(`http://equipment.test/api/equipment/${id}`, { method: 'DELETE' }),
        { params: Promise.resolve({ id }) },
      ),
    )
    return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function unit(unitId: string) {
  return (await db.execute(sql`select * from equipment_units where id = ${unitId}`)).rows[0] as
    | Record<string, unknown>
    | undefined
}

async function audits(orgId: string, unitId: string, action: string) {
  return (await db.execute(sql`select changes from audit_log where org_id = ${orgId} and table_name = 'equipment_units' and row_id = ${unitId} and action = ${action} order by id`)).rows as { changes: { before: Record<string, unknown>; after?: Record<string, unknown> } }[]
}

test('DELETE removes a draft unit and audits the locked before-image', async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await call(unitId)
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal((await unit(unitId)), undefined)
    const rows = await audits(org.orgId, unitId, 'delete')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.changes.before.status, 'draft')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('DELETE refuses a live unit without touching it or auditing success', async () => {
  const { org, unitId } = await fixture('active')
  try {
    const result = await call(unitId)
    assert.equal(result.status, 409, JSON.stringify(result.json))
    assert.equal(result.json.error, 'draft_only_delete')
    assert.equal((await unit(unitId))!.status, 'active')
    assert.equal((await audits(org.orgId, unitId, 'delete')).length, 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

