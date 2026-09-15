import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Equipment PATCH canonicalizes purchasePrice/capacityQuantity to 4dp but
// never bounds their magnitude, so a pasted 20-digit figure sails through
// validation and dies in Postgres as a raw numeric(19,4) overflow (HTTP 500)
// instead of failing closed with a named 422.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __equipmentPatchMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__equipmentPatchMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
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

async function fixture() {
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

async function purchasePrice(unitId: string): Promise<string> {
  const rows = (await db.execute<{ purchase_price: string }>(sql`
    select purchase_price::text as purchase_price from equipment_units where id = ${unitId}`)).rows
  return rows[0]!.purchase_price
}

test('PATCH refuses a purchase price wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await patch(unitId, { purchasePrice: '99999999999999999999' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await purchasePrice(unitId), '100.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a capacity quantity wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await patch(unitId, { capacityQuantity: '99999999999999999999', capacityUnit: 'hours' })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await purchasePrice(unitId), '100.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still saves a column-maximum purchase price with identical read-back', { skip: !DB }, async () => {
  const { org, unitId } = await fixture()
  try {
    const result = await patch(unitId, { purchasePrice: '999999999999999.9999' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    assert.equal(await purchasePrice(unitId), '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
