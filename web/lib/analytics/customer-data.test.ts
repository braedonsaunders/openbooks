import assert from 'node:assert/strict'
import test from 'node:test'
import { exactMarginPercent, exactProfit } from './customer-profitability-money'
import { isProfitLeak, profitTierOf, ratePayment, scorePayment } from './customer-data'

const bands = {
  highDays: 60, highPenalty: 40,
  mediumDays: 30, mediumPenalty: 20,
  lowDays: 15, lowPenalty: 10,
  perInvoice: 10, cap: 40,
}
const ratings = { excellent: 80, good: 60, fair: 40 }

test('a customer with no paid invoice earns no payment score, never a perfect 100', () => {
  assert.equal(scorePayment(null, 0, bands), null)
  assert.equal(scorePayment(null, 3, bands), null)
  assert.equal(ratePayment(null, ratings), 'unknown')
})

test('measured payment timing scores through the configured DSO and overdue bands', () => {
  assert.equal(scorePayment(10, 0, bands), 100)
  assert.equal(scorePayment(20, 0, bands), 90)
  assert.equal(scorePayment(45, 0, bands), 80)
  assert.equal(scorePayment(70, 0, bands), 60)
  assert.equal(scorePayment(10, 2, bands), 80)
  assert.equal(scorePayment(70, 9, bands), 20)
  assert.equal(scorePayment(70, 99, bands), 20)
  assert.equal(ratePayment(95, ratings), 'excellent')
  assert.equal(ratePayment(70, ratings), 'good')
  assert.equal(ratePayment(50, ratings), 'fair')
  assert.equal(ratePayment(10, ratings), 'poor')
})

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
