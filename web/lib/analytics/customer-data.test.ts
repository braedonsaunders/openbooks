import assert from 'node:assert/strict'
import test from 'node:test'
import { exactMarginPercent, exactProfit } from './customer-profitability-money'
import { ANALYTICS_CONFIG } from './config-spec'
import { englishCatalogMessage } from './catalog-strings'
import { customerStrings } from './customer-strings'
import { atRiskCustomersOf, compositeScoreOf, concentrationOf, healthScoreOf, isProfitLeak, profitTierOf, rankAtRiskCustomers, ratePayment, scorePayment, weightsRefusal, type CustomerData, type CustomerRow } from './customer-data'

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

const healthWeights = { recency: 25, frequency: 25, monetary: 30, payment: 20 }

test('dropping the payment term re-normalises the rest instead of awarding phantom points', () => {
  const terms = { recency: 100, frequency: 100, monetary: 100, payment: null as number | null }
  const { score, scoredWithoutPayment } = healthScoreOf(terms, healthWeights, 0)
  assert.equal(scoredWithoutPayment, true)
  // (100·25 + 100·25 + 100·30) / 80, not / 100 and not + 15 phantom points.
  assert.equal(score, 100)
  const withPayment = healthScoreOf({ ...terms, payment: 50 }, healthWeights, 0)
  assert.equal(withPayment.scoredWithoutPayment, false)
  assert.equal(withPayment.score, 90)
})

test('a broken weight sum refuses by name with the reachable remedy, never a throw', () => {
  const strings = customerStrings(englishCatalogMessage, 'en')
  assert.equal(weightsRefusal(ANALYTICS_CONFIG.customerIntelligence.defaults, strings), null)
  const broken = { ...ANALYTICS_CONFIG.customerIntelligence.defaults, healthWeightRecency: 24 }
  const refusal = weightsRefusal(broken, strings)
  assert.ok(refusal, 'a hand-edited weight group that no longer sums to 100 must refuse')
  assert.ok(refusal.includes('healthWeightRecency'), `the refusal must name the broken group, got: ${refusal}`)
  assert.ok(refusal.includes('Configuration'), `the refusal must name the reachable remedy, got: ${refusal}`)
})

test('no term left means no score, never a 0 that grades as F', () => {
  const { score } = healthScoreOf(
    { recency: 100, frequency: 100, monetary: 100, payment: null },
    { recency: 0, frequency: 0, monetary: 0, payment: 100 },
    0,
  )
  assert.equal(score, null)
  assert.equal(compositeScoreOf([]), null)
  assert.equal(compositeScoreOf([{ value: 80, weight: 0 }]), null)
  assert.equal(compositeScoreOf([{ value: 80, weight: 30 }, { value: 60, weight: 20 }]), 72)
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

test('at-risk is critical or high churn only: medium and low stay off the widget', () => {
  const rows = ['critical', 'high', 'medium', 'low'].map((churnLevel, i) => ({
    id: `c${i}`, name: `Co ${i}`, churnLevel,
  })) as CustomerRow[]
  assert.deepEqual(atRiskCustomersOf(rows).map((r) => r.id), ['c0', 'c1'])
})

test('the at-risk list ranks the five highest churn scores, medium and low never included', () => {
  const rows = [
    { id: 'a', name: 'A', churnLevel: 'high', churnScore: 60 },
    { id: 'b', name: 'B', churnLevel: 'critical', churnScore: 95 },
    { id: 'c', name: 'C', churnLevel: 'medium', churnScore: 99 },
    { id: 'd', name: 'D', churnLevel: 'critical', churnScore: 80 },
    { id: 'e', name: 'E', churnLevel: 'high', churnScore: 70 },
    { id: 'f', name: 'F', churnLevel: 'low', churnScore: 5 },
    { id: 'g', name: 'G', churnLevel: 'critical', churnScore: 75 },
    { id: 'h', name: 'H', churnLevel: 'high', churnScore: 65 },
  ] as CustomerRow[]
  // Highest churn first; the medium 99 and the low stay off the tile even
  // though the medium outscores every at-risk row.
  assert.deepEqual(rankAtRiskCustomers(rows).map((r) => r.id), ['b', 'd', 'g', 'e', 'h'])
})

test('concentration reads the dashboard KPIs, never a recomputation', () => {
  const kpis = { totalRevenue: '1000', hhiScaled: 2450, hhiLevel: 'moderate', customersFor80Pct: 3, topCustomerShare: 42.5 } as CustomerData['kpis']
  assert.deepEqual(concentrationOf(kpis), {
    hhi: 2450, level: 'moderate', customersFor80Pct: 3, topSharePct: 42.5,
  })
})

test('concentration is null without recognized revenue: no HHI of 0 that reads as diversified', () => {
  const kpis = { totalRevenue: '0', hhiScaled: 0, hhiLevel: 'low', customersFor80Pct: 0, topCustomerShare: 0 } as CustomerData['kpis']
  assert.equal(concentrationOf(kpis), null)
})
