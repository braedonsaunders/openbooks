import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { channelCards } from './channel-cards.ts'

const channels = [
  { id: 'a', kind: 'shopify', name: 'A', status: 'active', currency: 'USD', externalAccount: 'a.myshopify.com', lastSyncAt: null, attention: { failed: 2, dead: 1, lastReceivedAt: null } },
  { id: 'b', kind: 'shopify', name: 'B', status: 'paused', currency: 'USD', externalAccount: 'b.myshopify.com', lastSyncAt: null, attention: { failed: 0, dead: 0, lastReceivedAt: '2026-10-01T00:00:00Z' } },
]

const margin = [
  { channelId: 'a', channelName: 'A', currency: 'USD', minorUnits: 2, orders: 3, revenueMinor: '10000', cm2Minor: '4000', estimatedOrders: 0, adSpendMinor: '1000' },
  { channelId: 'a', channelName: 'A', currency: 'EUR', minorUnits: 2, orders: 1, revenueMinor: '2000', cm2Minor: '500', estimatedOrders: 0, adSpendMinor: '0' },
]

describe('channelCards', () => {
  it('lists each channel exactly once with its own attention and margins', () => {
    const cards = channelCards(channels, margin)
    assert.equal(cards.length, 2)
    const [first, second] = cards
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.outstanding, 3)
    assert.deepEqual(
      first.marginRows.map((row) => row.currency),
      ['USD', 'EUR'],
    )
    assert.equal(second.outstanding, 0)
    assert.deepEqual(second.marginRows, [])
  })

  it('works without margin data', () => {
    const cards = channelCards(channels, null)
    assert.equal(cards.length, 2)
    const [first] = cards
    assert.ok(first)
    assert.equal(first.outstanding, 3)
  })
})
