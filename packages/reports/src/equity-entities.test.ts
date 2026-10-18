import assert from 'node:assert/strict'
import test from 'node:test'
import { EQUITY_REPORT_ENTITIES } from './equity-entities'
import { REPORT_ENTITY_MAP } from './entities'
import { BUILT_IN_REPORT_DEFINITION_MAP, applyBuiltInUrlFilters } from './built-ins'
import { validateCustomQuery } from './validate'
import { compileCustomQuery } from './custom-query'

const ORG = '00000000-0000-4000-8000-000000000001'

test('equity reports are gated by the equity feature and permission, org-bounded and scoped to the legal entity', () => {
  assert.equal(EQUITY_REPORT_ENTITIES.length, 3)
  for (const entity of EQUITY_REPORT_ENTITIES) {
    assert.equal(REPORT_ENTITY_MAP[entity.key], entity)
    assert.equal(entity.requiredPermission, 'equity.read')
    assert.equal(entity.featureKey, 'equity')
    assert.ok(entity.subsidiaryScope?.column, `${entity.key} carries a legal-entity boundary`)
    const definition = BUILT_IN_REPORT_DEFINITION_MAP[entity.key.replaceAll('_', '-')]
    assert.ok(definition, entity.key)
    const compiled = compileCustomQuery(entity, validateCustomQuery(definition.query), ORG)
    assert.match(compiled.text, new RegExp(entity.orgColumn.replace('.', '\\.')))
  }
})

test('the expense schedule sums only the change each run posted, never the cumulative snapshots', () => {
  const schedule = BUILT_IN_REPORT_DEFINITION_MAP['equity-stock-compensation-schedule']
  assert.ok(schedule)
  const query = validateCustomQuery(schedule.query)
  assert.equal(query.entity, 'equity_compensation_run_lines')
  assert.deepEqual(schedule.query.measures?.map((measure) => measure.column), ['period'])
  compileCustomQuery(REPORT_ENTITY_MAP.equity_compensation_run_lines!, query, ORG)
  const cumulative = REPORT_ENTITY_MAP.equity_compensation_run_lines!.columns.find((column) => column.key === 'cumulative')
  assert.equal(cumulative?.snapshot, true)
  assert.throws(() => compileCustomQuery(REPORT_ENTITY_MAP.equity_compensation_run_lines!, validateCustomQuery({
    ...schedule.query,
    measures: [{ fn: 'sum', column: 'cumulative', label: 'Cumulative' }],
  }), ORG))
})

test('the cap table report bounds the position ledger by the as-of date only, never by a fiscal window', () => {
  const entity = REPORT_ENTITY_MAP.equity_cap_table_positions!
  assert.equal(entity.defaultPeriodField, null, 'a fiscal window would drop the movements before it')
  const definition = BUILT_IN_REPORT_DEFINITION_MAP['equity-cap-table']
  assert.ok(definition)
  assert.equal(definition.query.periodField, null)
  assert.deepEqual(definition.query.breakouts?.map((breakout) => breakout.column), ['share_class', 'position_kind', 'holder'])
  assert.deepEqual(definition.query.measures?.map((measure) => measure.column), ['outstanding', 'as_converted_outstanding', 'awards_outstanding', 'pool_available', 'fully_diluted'])
  const asOf = validateCustomQuery(applyBuiltInUrlFilters(definition, { asOf: '2026-09-30' }))
  const compiled = compileCustomQuery(entity, asOf, ORG)
  assert.match(compiled.text, /m\.effective_on <= \$\d+/)
  assert.ok(compiled.values.includes('2026-09-30'))
  assert.doesNotMatch(compiled.text, /m\.effective_on >= /)
  assert.throws(() => applyBuiltInUrlFilters(definition, { asOf: '2026-02-30' }), /Invalid report parameter: asOf/)
})
