import assert from 'node:assert/strict'
import test from 'node:test'

// Exercise the unchanged route with native permissions, feature state and validation.
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createFairValueFixture, callFairValueRoute } = await import('../../../../../lib/testing/fair-value-fixture.ts')
let current: Awaited<ReturnType<typeof createFairValueFixture>>

async function fixture() {
  current = await createFairValueFixture()
  return current
}

async function call(method: 'POST' | 'PATCH', id: string, body: unknown) {
  return callFairValueRoute(current, method, id, body)
}

async function rowCount(itemId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from fair_value_prices where item_id = ${itemId}`)).rows
  return rows[0]!.n
}

test('POST refuses a unit price wider than numeric(19,4) without writing', async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await call('POST', itemId, { currency: 'CAD', unitPrice: '99999999999999999999' })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.match(String((result.json as { error: string }).error), /Unit price.*15 whole digits/)
    assert.equal(await rowCount(itemId), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST refuses low/high values wider than numeric(19,4) without writing', async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await call('POST', itemId, {
      currency: 'CAD', unitPrice: '10', lowValue: '99999999999999999999', highValue: '99999999999999999999',
    })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.match(String((result.json as { error: string }).error), /Low value.*15 whole digits/)
    assert.equal(await rowCount(itemId), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a unit price wider than numeric(19,4) without writing', async () => {
  const { org, itemId } = await fixture()
  try {
    const created = await call('POST', itemId, { currency: 'CAD', unitPrice: '10' })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    const rowId = (created.json as { id: string }).id
    const result = await call('PATCH', itemId, { id: rowId, currency: 'CAD', unitPrice: '99999999999999999999' })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.match(String((result.json as { error: string }).error), /Unit price.*15 whole digits/)
    const rows = (await db.execute<{ unit_price: string }>(sql`
      select unit_price::text as unit_price from fair_value_prices where id = ${rowId}`)).rows
    assert.equal(rows[0]!.unit_price, '10.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still saves a column-maximum unit price with identical read-back', async () => {
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
