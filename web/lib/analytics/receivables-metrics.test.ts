import assert from 'node:assert/strict'
import test from 'node:test'
import { receivablesRatio, cumulativeReceivableMaturity } from './receivables-metrics'
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

test('receivables page and lazy tabs share point-in-time periods while explicit custom dates remain unchanged', () => {
  assert.equal(analyticsSourceQuery({}, 'receivables-intelligence').period, 'today')
  assert.equal(analyticsQueryString({}, 'receivables-intelligence'), 'period=today')
  assert.notEqual(analyticsSourceQuery({}).period, 'today')
  for (const preset of AGING_PERIOD_PRESETS) assert.equal(agingPeriodPreset(preset), preset)
  for (const preset of ['this_fiscal_year', 'next_month', 'this_month', 'unknown']) {
    assert.equal(agingPeriodPreset(preset), 'today')
    assert.equal(analyticsQueryString({ period: preset }, 'receivables-intelligence'), 'period=today')
  }
  const custom = { period: 'custom', from: '2026-08-01', to: '2026-08-31' }
  assert.deepEqual(analyticsSourceQuery({ ...custom, tab: 'customers', relatedParty: 'private' }, 'receivables-intelligence'), custom)
})
