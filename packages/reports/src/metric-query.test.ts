import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
import { REPORT_ENTITY_MAP } from './entities'
import { compileCustomQuery } from './custom-query'
import { reportMetricQuery } from './metric-query'
import { runCustomQuery } from './run'
import { validateCustomQuery } from './validate'
import { resolvePeriodPresetLeaves } from './period-presets'

const orgId = '00000000-0000-4000-8000-000000000001'
const source = (slug: string) => BUILT_IN_REPORT_DEFINITION_MAP[slug]!.query

test('large customer/item/employee sources aggregate only denomination groups in SQL', async () => {
  for (const slug of ['open-ar-by-customer', 'order-margin-by-sku', 'order-margin-by-channel', 'payroll-cost-by-month', 'crm-forecast-by-owner']) {
    const original = source(slug), query = reportMetricQuery(original)
    const entity = REPORT_ENTITY_MAP[query.entity]!
    assert.deepEqual(query.filters, validateCustomQuery(original).filters, slug)
    assert.ok(query.breakouts!.every((breakout) => ['currency', 'base_currency', 'reporting_currency', 'book', 'book_code', 'book_id'].includes(breakout.column)), slug)
    assert.equal(query.groupBy, null)
    const compiled = compileCustomQuery(entity, await resolvePeriodPresetLeaves(query, async () => ({ from: '2026-01-01', to: '2026-12-31' })), orgId, { allowedBookIds: [orgId], allowedSubsidiaryIds: entity.subsidiaryScope ? [orgId] : null })
    assert.ok(compiled.values.includes(orgId))
    assert.match(compiled.text, /SUM\(/i)
    assert.ok(query.measures!.filter((measure) => !measure.hidden).length <= 4)
  }
})

test('contribution formulas retain transitive inputs and refusal guards', () => {
  const query = reportMetricQuery(source('order-margin-by-sku'))
  for (const key of ['revenue', 'goods', 'fees', 'marketing', 'cm1', 'cm2', 'cm3']) assert.ok(query.measures!.some((measure) => measure.key === key), key)
  const guarded = reportMetricQuery(source('order-margin-by-sku'), 5)
  assert.deepEqual(guarded.measures!.find((measure) => measure.key === 'margin_pct')!.guards, source('order-margin-by-sku').measures!.find((measure) => measure.key === 'margin_pct')!.guards)
})

test('temporal balances retain their native partition; unused closing balances are not calculated', () => {
  const mrr = reportMetricQuery(source('mrr-movements'), 7)
  assert.deepEqual(mrr.breakouts, source('mrr-movements').breakouts)
  const liability = reportMetricQuery(source('stored-value-liability-roll-forward'))
  assert.ok(liability.measures!.every((measure) => measure.fn === 'sum'))
  assert.deepEqual(liability.breakouts, [{ column: 'currency' }])
})

test('metric projection cannot turn an explicit cross-book report into a primary-book report', () => {
  const query = reportMetricQuery({ ...source('open-ar-by-customer'), breakouts: [{ column: 'party_name' }, { column: 'book_id' }] })
  assert.ok(query.breakouts!.some((breakout) => breakout.column === 'book_id'))
})

test('a metric band reads exact totals from one native aggregate rather than 1000 truncated item groups', async () => {
  const query = reportMetricQuery(source('order-margin-by-sku'))
  let calls = 0
  const result = await runCustomQuery({ async query(text) {
    calls += 1
    assert.match(text, /GROUP BY 1\b/)
    // One database aggregate of a population larger than the old group limit.
    return { rows: [{ d0: 'CAD', m0: '9007199254740993.01', m1: '-1.01', m2: '-2.00', m3: '-3.00', m4: null, m5: null, m6: null, m7: null,
      __txn_n: '1', __txn_v: 'CAD' }] }
  } }, query, { orgId, entityMap: REPORT_ENTITY_MAP })
  assert.equal(calls, 1)
  assert.equal(result.summary.find((metric) => metric.label.toLowerCase().includes('revenue'))?.value, '9007199254740993.0100')
  assert.equal(result.summary.find((metric) => metric.label.toLowerCase().includes('cm3 after marketing'))?.value, '9007199254740987.0000')
})
