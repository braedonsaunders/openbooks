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

async function post(id: string, body: unknown) {
  return callFairValueRoute(current, 'POST', id, body)
}

test('POST refuses malformed policy values without writing', async () => {
  const { org, itemId } = await fixture()
  try {
    const invalidDate = await post(itemId, { currency: 'CAD', unitPrice: '10', effectiveFrom: '2024-02-30' })
    const invalidFlag = await post(itemId, { currency: 'CAD', unitPrice: '10', effectiveFrom: '2024-02-29', isActive: 'false' })
    const rows = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from fair_value_prices where item_id = ${itemId}`)).rows
    assert.deepEqual([invalidDate.status, invalidFlag.status, rows[0]!.n], [400, 400, 0])
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still saves a real effective date', async () => {
  const { org, itemId } = await fixture()
  try {
    const result = await post(itemId, { currency: 'CAD', unitPrice: '10', effectiveFrom: '2024-02-29' })
    assert.equal(result.status, 200, JSON.stringify(result.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
