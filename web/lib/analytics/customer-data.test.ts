import assert from 'node:assert/strict'
import test from 'node:test'
import { exactMarginPercent, exactProfit } from './customer-profitability-money'
import { isProfitLeak, profitTierOf } from './customer-data'

test('customer profit keeps a cent beyond the safe integer range', () => {
  assert.equal(exactProfit('9007199254740993.01', '9007199254740993.00'), '0.0100')
})

test('margin without revenue is undefined, never a 0% that tiers as marginal', () => {
  assert.equal(exactMarginPercent('5', '0'), null)
  assert.equal(exactMarginPercent('-5', '0'), null)
  assert.equal(exactMarginPercent('5', '-100'), null)
  assert.equal(exactMarginPercent('25', '100'), 25)
})

test('a costed customer with no revenue tiers as loss, not marginal', () => {
  const cuts = { high: 40, medium: 25, low: 10 }
  assert.equal(profitTierOf(null, '-5', cuts), 'loss')
  assert.equal(profitTierOf(null, '0', cuts), 'marginal')
  assert.equal(profitTierOf(-3.5, '-5', cuts), 'loss')
  assert.equal(profitTierOf(0, '0', cuts), 'marginal')
  assert.equal(profitTierOf(45, '45', cuts), 'high')
})

test('a profit leak is a revenue share with margin below target, never an absolute amount', () => {
  const cuts = { revenueSharePct: 10, marginTarget: 15 }
  assert.equal(isProfitLeak({ revenue: '200', totalRevenue: '1000', marginPct: 5 }, cuts), true)
  assert.equal(isProfitLeak({ revenue: '50', totalRevenue: '1000', marginPct: 5 }, cuts), false)
  assert.equal(isProfitLeak({ revenue: '200', totalRevenue: '1000', marginPct: 20 }, cuts), false)
  assert.equal(isProfitLeak({ revenue: '200', totalRevenue: '1000', marginPct: null }, cuts), false)
  assert.equal(isProfitLeak({ revenue: '0', totalRevenue: '0', marginPct: 5 }, cuts), false)
})
