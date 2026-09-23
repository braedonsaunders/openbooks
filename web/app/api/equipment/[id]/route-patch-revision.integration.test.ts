import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Equipment PATCH rewrote every financial and lifecycle column from a
// pre-transaction read, so concurrent edits silently lost one writer's
// change and the audit logged a stale before-image. PATCH now locks the
// row first, enforces the caller's revision, writes only changed fields,
// and audits the actual before/after rows.
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
const { PATCH } = await import('./route.ts')

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

async function call(id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const response: Response = await withOrgContext(state.orgId, () =>
      PATCH(
        new Request(`http://equipment.test/api/equipment/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
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

test('PATCH without a revision is refused without writing', async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await call(unitId, { name: 'Sneaky Rename' })
    assert.equal(result.status, 422, JSON.stringify(result.json))
    assert.equal(result.json.code, 'revision_required')
    const row = (await unit(unitId))!
    assert.equal(row.name, 'Test Unit')
    assert.equal(row.revision, 0)
    assert.equal((await audits(org.orgId, unitId, 'update')).length, 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a stale revision is refused and the winners columns survive intact', async () => {
  const { org, unitId } = await fixture()
  try {
    // Writer A moves the price at revision 0.
    const first = await call(unitId, { purchasePrice: '200', revision: 0 })
    assert.equal(first.status, 200, JSON.stringify(first.json))
    // Writer B loaded revision 0 and sends a full-form payload carrying the
    // stale price alongside its own date change: the fence must refuse
    // instead of silently restoring the old price and applying the date.
    const stale = await call(unitId, {
      purchasePrice: '100.0000',
      inServiceOn: '2026-02-01',
      revision: 0,
    })
    assert.equal(stale.status, 409, JSON.stringify(stale.json))
    assert.equal(stale.json.code, 'stale_revision')
    const row = (await unit(unitId))!
    assert.equal(row.purchase_price, '200.0000')
    assert.equal(row.in_service_on, null)
    assert.equal(row.revision, 1)
    // The current revision still applies cleanly on top.
    const retry = await call(unitId, { inServiceOn: '2026-02-01', revision: 1 })
    assert.equal(retry.status, 200, JSON.stringify(retry.json))
    assert.equal((await unit(unitId))!.in_service_on, '2026-02-01')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH writes only changed fields and audits actual before/after', async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await call(unitId, { name: 'Renamed Unit', purchasePrice: '100.0000', revision: 0 })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const rows = await audits(org.orgId, unitId, 'update')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.changes.before.name, 'Test Unit')
    assert.equal(rows[0]!.changes.after!.name, 'Renamed Unit')
    assert.equal(rows[0]!.changes.before.purchase_price, '100.0000')
    assert.equal(rows[0]!.changes.after!.purchase_price, '100.0000')
    assert.equal(rows[0]!.changes.before.revision, 0)
    assert.equal(rows[0]!.changes.after!.revision, 1)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('replaying the stored values is a no-op without a new revision or audit', async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await call(unitId, { name: 'Test Unit', revision: 0 })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal((await unit(unitId))!.revision, 0)
    assert.equal((await audits(org.orgId, unitId, 'update')).length, 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

