import assert from 'node:assert/strict'
import test from 'node:test'
import { receivablesRatio, cumulativeReceivableMaturity, collectionCustomerReasons, sparklineCoordinates, CollectionPeriodError } from './receivables-metrics'
import { analyticsDashboardDenied, ANALYTICS_DASHBOARD_MAP } from './dashboard-catalog'
import { analyticsQueryString, analyticsSourceQuery } from './query-params'
import { agingBucketIndex, agingBasisDate } from '../aging-basis'
import { AGING_PERIOD_PRESETS, agingPeriodPreset } from '../aging-periods'

test('shared aging retains the historical 90-day boundary and due-date precedence', () => {
  for (let days = -10; days <= 120; days++) {
    const expected = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days < 90 ? 3 : 4
    assert.equal(agingBucketIndex(days), expected, `aging at ${days} days`)
  }
  assert.equal(agingBasisDate({ dueDate: '2026-07-31', postingDate: '2026-07-01' }), '2026-07-31')
  assert.equal(agingBasisDate({ dueDate: null, postingDate: '2026-07-01' }), '2026-07-01')
})

test('receivables ratios preserve exact balances and refuse an empty collectible denominator', () => {
  assert.equal(receivablesRatio('100000000000000.0000', '400000000000000.0000'), '0.2500')
  assert.equal(receivablesRatio('0.0000', '100.0000'), '0.0000')
  assert.equal(receivablesRatio('100.0000', '0.0000'), null)
  assert.equal(receivablesRatio('100.0000', '-100.0000'), null)
})

test('contractual maturity accumulates exact gross balances without rounding at the chart boundary', () => {
  assert.deepEqual(cumulativeReceivableMaturity([{ gross: '999999999999999.9999' }, { gross: '0.0001' }, { gross: '0.0000' }]),
    ['999999999999999.9999', '1000000000000000.0000', '1000000000000000.0000'])
})

test('the receivables dashboard requires both analytics and receivables grants without an industry dependency', () => {
  const definition = ANALYTICS_DASHBOARD_MAP['receivables-intelligence']!
  assert.equal(analyticsDashboardDenied({ permissions: new Set(['reports.read']), allowedSubsidiaryIds: null }, definition), 'ar.read')
  assert.equal(analyticsDashboardDenied({ permissions: new Set(['ar.read']), allowedSubsidiaryIds: null }, definition), 'reports.read')
  assert.equal(analyticsDashboardDenied({ permissions: new Set(['reports.read', 'ar.read']), allowedSubsidiaryIds: new Set() }, definition), null)
  assert.deepEqual(definition.industries, [])
  assert.equal(definition.feature, undefined)
})

test('receivables behavior windows and server-side portfolio filters share a canonical lazy-tab identity', () => {
  assert.deepEqual(analyticsSourceQuery({}, 'receivables-intelligence'), analyticsSourceQuery({}))
  for (const period of ['today', 'this_month', 'last_month', 'this_fiscal_year']) {
    assert.equal(analyticsSourceQuery({ period }, 'receivables-intelligence').period, period)
  }
  const custom = { period: 'custom', from: '2026-07-01', to: '2026-07-31' }
  assert.deepEqual(analyticsSourceQuery({ ...custom, tab: 'customers', relatedParty: 'private', customerQ: '  Acme  ', customerPage: '-2', signal: 'deteriorating' }, 'receivables-intelligence'),
    { ...custom, customerQ: 'Acme', customerPage: '1', signal: 'deteriorating' })
  assert.equal(analyticsSourceQuery({ period: 'custom', signal: 'unknown' }, 'receivables-intelligence').signal, undefined)
  assert.equal(analyticsQueryString({ ...custom, customerQ: 'A & B', customerPage: '2' }, 'receivables-intelligence'), 'period=custom&customerQ=A+%26+B&customerPage=2&from=2026-07-01&to=2026-07-31')
  for (const preset of AGING_PERIOD_PRESETS) assert.equal(agingPeriodPreset(preset), preset)
  assert.equal(agingPeriodPreset('this_fiscal_year'), 'today', 'the native aging report retains its point-in-time convention')
})

test('collection flags retain independent exact evidence and distinguish absent credit limits', () => {
  const healthy = { deteriorating: false, severe: '0.0000', failed: 0, suppressed: 0, missingTerms: '0.0000', held: false }
  assert.deepEqual(collectionCustomerReasons(healthy), [])
  assert.deepEqual(collectionCustomerReasons({ ...healthy, deteriorating: true, severe: '0.0001', suppressed: 1, missingTerms: '0.0001', held: true, creditLimit: '999999999999999.9998', committed: '999999999999999.9999' }),
    ['deteriorating', 'severe', 'delivery', 'terms', 'held', 'credit'])
  assert.deepEqual(collectionCustomerReasons({ ...healthy, creditLimit: null, committed: '100.0000' }), [])
  assert.deepEqual(collectionCustomerReasons({ ...healthy, creditLimit: '100.0000', committed: '100.0000' }), [])
})

test('payment sparklines preserve unknown observations and handle flat and early-payment histories', () => {
  assert.deepEqual(sparklineCoordinates([null, 12, null]), [])
  assert.deepEqual(sparklineCoordinates([null, null]), [])
  assert.deepEqual(sparklineCoordinates([5, 5]), [{ x: 2, y: 16 }, { x: 98, y: 16 }])
  assert.deepEqual(sparklineCoordinates([-5, null, 15]), [{ x: 2, y: 28 }, { x: 98, y: 4 }])
  assert.equal(new CollectionPeriodError('Select a historical period').status, 422)
})
