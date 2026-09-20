import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Equipment PATCH validates some references (fixedAssetId/rateBookId get an
// isUuid check) but binds subsidiaryId and chargeItemId straight into their
// existence probes, so a malformed value escapes as a raw Postgres uuid
// throw (HTTP 500) instead of the same 422 the unknown-id path returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __equipmentPatchRefState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__equipmentPatchRefState;
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
const DB = !!process.env.OPENBOOKS_DB_URL

interface Fixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  unitId: string
}

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const unitId = (await db.execute<{ id: string }>(sql`
    insert into equipment_units (org_id, name, unit_number, status, subsidiary_id, purchase_price)
    values (${org.orgId}, 'Test Unit', 'TEST-001', 'draft', ${org.subsidiaryId}, '100.0000')
    returning id`)).rows[0]!.id
  return { org, unitId }
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://equipment.test/api/equipment/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

test('PATCH rejects a malformed subsidiaryId instead of throwing', { skip: !DB }, async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await patch(unitId, { subsidiaryId: 'not-a-uuid' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH rejects a malformed chargeItemId instead of throwing', { skip: !DB }, async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await patch(unitId, { chargeItemId: 'not-a-uuid' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still renames a unit with valid references', { skip: !DB }, async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await patch(unitId, { name: 'Renamed Unit' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
