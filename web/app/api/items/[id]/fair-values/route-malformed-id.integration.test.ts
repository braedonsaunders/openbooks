import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Fair-value PATCH and DELETE scope their row by the path item id but never
// gate it: GET and POST both return 404 for a malformed item id while
// PATCH/DELETE bind it straight into the uuid comparison and escape as a raw
// Postgres throw (HTTP 500). Same intra-file contract on every verb.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __fairValuePathIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__fairValuePathIdState;
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
const { PATCH, DELETE } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

interface Fixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>
  itemId: string
  rowId: string
}

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  const itemId = (await db.execute<{ id: string }>(sql`
    insert into items (org_id, kind, name, is_active)
    values (${org.orgId}, 'service', 'Fair Value Item', true)
    returning id`)).rows[0]!.id
  const rowId = (await db.execute<{ id: string }>(sql`
    insert into fair_value_prices (org_id, item_id, currency, unit_price, is_active)
    values (${org.orgId}, ${itemId}, 'CAD', '10.0000', true)
    returning id`)).rows[0]!.id
  return { org, itemId, rowId }
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://fv.test/api/items/${id}/fair-values`, {
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

async function remove(id: string, rowId: string): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => DELETE(
      new Request(`http://fv.test/api/items/${id}/fair-values?id=${rowId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

const validPatch = (rowId: string) => ({
  id: rowId,
  currency: 'CAD',
  unitPrice: '12.0000',
})

test('PATCH returns 404 for a malformed item id', { skip: !DB }, async () => {
  const { org, rowId } = await fixture()
  try {
    const result = await patch('not-a-uuid', validPatch(rowId))
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('DELETE returns 404 for a malformed item id', { skip: !DB }, async () => {
  const { org, rowId } = await fixture()
  try {
    const result = await remove('not-a-uuid', rowId)
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('unknown item ids still return the not-found contract', { skip: !DB }, async () => {
  const { org, rowId } = await fixture()
  try {
    const patched = await patch(randomUUID(), validPatch(rowId))
    assert.equal(patched.status, 404, JSON.stringify(patched.json))
    const deleted = await remove(randomUUID(), rowId)
    assert.equal(deleted.status, 404, JSON.stringify(deleted.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still updates a row under a valid item id', { skip: !DB }, async () => {
  const { org, itemId, rowId } = await fixture()
  try {
    const result = await patch(itemId, validPatch(rowId))
    assert.equal(result.status, 200, JSON.stringify(result.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
