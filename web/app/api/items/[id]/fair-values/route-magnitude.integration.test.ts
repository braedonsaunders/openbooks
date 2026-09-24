import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Fair-value POST/PATCH canonicalize unitPrice/lowValue/highValue to 4dp but
// never bound their magnitude, so a pasted 20-digit figure sails through
// validation and dies in Postgres as a raw numeric(19,4) overflow (HTTP 500)
// instead of failing closed with the same 400 the junk-input path returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __fairValueMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__fairValueMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/authz') return virtual(`
      export function guardUnrestrictedScope() { return null }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST, PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const itemId = (await db.execute<{ id: string }>(sql`
    insert into items (org_id, kind, name, is_active)
    values (${org.orgId}, 'service', 'Fair Value Item', true)
    returning id`)).rows[0]!.id
  return { org, itemId }
}

async function call(method: 'POST' | 'PATCH', id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const fn = method === 'POST' ? POST : PATCH
    const response = await withOrgContext(state.orgId, () => fn(
      new Request(`http://fv.test/api/items/${id}/fair-values`, {
        method,
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

async function rowCount(itemId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from fair_value_prices where item_id = ${itemId}`)).rows
  return rows[0]!.n
}

test('POST refuses a unit price wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await call('POST', itemId, { currency: 'CAD', unitPrice: '99999999999999999999' })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await rowCount(itemId), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST refuses low/high values wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await call('POST', itemId, {
      currency: 'CAD', unitPrice: '10', lowValue: '99999999999999999999', highValue: '99999999999999999999',
    })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await rowCount(itemId), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a unit price wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, itemId } = await fixture()
  try {
    const created = await call('POST', itemId, { currency: 'CAD', unitPrice: '10' })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    const rowId = (created.json as { id: string }).id
    const result = await call('PATCH', itemId, { id: rowId, currency: 'CAD', unitPrice: '99999999999999999999' })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    const rows = (await db.execute<{ unit_price: string }>(sql`
      select unit_price::text as unit_price from fair_value_prices where id = ${rowId}`)).rows
    assert.equal(rows[0]!.unit_price, '10.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still saves a column-maximum unit price with identical read-back', { skip: !DB }, async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await call('POST', itemId, { currency: 'CAD', unitPrice: '999999999999999.9999' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const rowId = (result.json as { id: string }).id
    const rows = (await db.execute<{ unit_price: string }>(sql`
      select unit_price::text as unit_price from fair_value_prices where id = ${rowId}`)).rows
    assert.equal(rows[0]!.unit_price, '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
