import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Exercise the unchanged route with native permissions, feature state and validation.
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createFairValueFixture, callFairValueRoute } = await import('../../../../../lib/testing/fair-value-fixture.ts')
let current: Awaited<ReturnType<typeof createFairValueFixture>>

async function fixture() {
  current = await createFairValueFixture()
  const { org, itemId } = current
  const rowId = (await db.execute<{ id: string }>(sql`
    insert into fair_value_prices (org_id, item_id, currency, unit_price, is_active)
    values (${org.orgId}, ${itemId}, 'CAD', '10.0000', true)
    returning id`)).rows[0]!.id
  return { org, itemId, rowId }
}

async function patch(id: string, body: unknown) {
  return callFairValueRoute(current, 'PATCH', id, body)
}

async function remove(id: string, rowId: string) {
  return callFairValueRoute(current, 'DELETE', id, undefined, rowId)
}

const validPatch = (rowId: string) => ({
  id: rowId,
  currency: 'CAD',
  unitPrice: '12.0000',
})

test('PATCH refuses a malformed item id before any price mutation', async () => {
  const { org, rowId } = await fixture()
  try {
    const result = await patch('not-a-uuid', validPatch(rowId))
    assert.equal(result.status, 400, JSON.stringify(result.json))
    assert.match(String((result.json as { error: string }).error), /valid id/)
    const rows = (await db.execute<{ unit_price: string }>(sql`select unit_price::text as unit_price from fair_value_prices where id = ${rowId}`)).rows
    assert.equal(rows[0]!.unit_price, '10.0000', 'malformed path leaves the existing selling price unchanged')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('DELETE refuses a malformed item id before any price mutation', async () => {
  const { org, rowId } = await fixture()
  try {
    const result = await remove('not-a-uuid', rowId)
    assert.equal(result.status, 400, JSON.stringify(result.json))
    assert.match(String((result.json as { error: string }).error), /valid id/)
    const rows = (await db.execute<{ unit_price: string }>(sql`select unit_price::text as unit_price from fair_value_prices where id = ${rowId}`)).rows
    assert.equal(rows[0]!.unit_price, '10.0000', 'malformed path leaves the existing selling price unchanged')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('unknown item ids still return the not-found contract', async () => {
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

test('PATCH still updates a row under a valid item id', async () => {
  const { org, itemId, rowId } = await fixture()
  try {
    const result = await patch(itemId, validPatch(rowId))
    assert.equal(result.status, 200, JSON.stringify(result.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
