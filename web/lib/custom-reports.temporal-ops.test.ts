import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_FILTER_OPERATORS } from '@openbooks/reports'

// custom-reports is server-only in production; this suite runs the one pure
// export it needs with that guard stubbed.
const { TEMPORAL_OPS, reportPeriodField } = await import('./custom-reports.ts')

test('every viewer-override temporal op is a real filter operator', () => {
  // E47: a dead 'between' sat in the override set while no compiler or
  // validator accepts it, so the set claimed to govern filters that can
  // never exist. The set must stay within the valid operators.
  const valid = new Set<string>(REPORT_FILTER_OPERATORS as readonly string[])
  for (const op of TEMPORAL_OPS) {
    assert.ok(valid.has(op), `TEMPORAL_OPS member '${op}' is not a valid filter operator`)
  }
  assert.ok(!TEMPORAL_OPS.has('between'), "'between' compiles nowhere and must stay out of the override set")
})

test('current-state analytics stay complete while explicit and legacy date reports retain their period', () => {
  const snapshot = { entity: 'projects', columns: [], periodField: null }
  assert.equal(reportPeriodField(snapshot), null, 'current project counts must not become a start-date cohort')
  assert.equal(reportPeriodField({ ...snapshot, periodField: 'starts_on' }), 'starts_on')
  assert.equal(reportPeriodField({ entity: 'pay_stubs', columns: [], filters: { combinator: 'and', rules: [{ field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' }] } }), 'pay_date')
})
