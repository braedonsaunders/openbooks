import assert from 'node:assert/strict'
import test from 'node:test'
import { EQUITY_REPORT_ENTITIES } from './equity-entities'
import { REPORT_ENTITY_MAP } from './entities'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
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
    // Executors always pass the run's business date; point-in-time sources require it.
    const compiled = compileCustomQuery(entity, validateCustomQuery(definition.query), ORG, { asOf: '2026-10-18' })
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

test('the cap table report reads the position ledger as of one date, bounded from above only', () => {
  const entity = REPORT_ENTITY_MAP.equity_cap_table_positions!
  assert.equal(entity.asOfField, 'effective_on')
  const definition = BUILT_IN_REPORT_DEFINITION_MAP['equity-cap-table']
  assert.ok(definition)
  assert.equal(definition.urlFilters, undefined, 'the as-of date is the native as-of control, not a URL binding')
  assert.equal(definition.query.periodField, undefined)
  assert.deepEqual(definition.query.breakouts?.map((breakout) => breakout.column), ['share_class', 'position_kind', 'holder'])
  assert.deepEqual(definition.query.measures?.map((measure) => measure.column), ['outstanding', 'as_converted_outstanding', 'awards_outstanding', 'pool_available', 'fully_diluted'])
  const plan = validateCustomQuery(definition.query)
  // With no date chosen the run's business date bounds the movements.
  const today = compileCustomQuery(entity, plan, ORG, { asOf: '2026-10-18' })
  assert.match(today.text, /m\.effective_on <= \$\d+::date/)
  assert.ok(today.values.includes('2026-10-18'))
  assert.doesNotMatch(today.text, /m\.effective_on >=/, 'no lower bound: positions are cumulative')
  // A chosen as-of date replaces the business date, past or future.
  const chosen = compileCustomQuery(entity, validateCustomQuery({ ...definition.query, asOf: '2027-03-31' }), ORG, { asOf: '2026-10-18' })
  assert.ok(chosen.values.includes('2027-03-31'))
  assert.ok(!chosen.values.includes('2026-10-18'))
  // A point-in-time source never runs without a date.
  assert.throws(() => compileCustomQuery(entity, plan, ORG), /is read as of a date/)
})

test('an as-of date is a calendar date and belongs only to point-in-time sources', () => {
  const definition = BUILT_IN_REPORT_DEFINITION_MAP['equity-cap-table']!
  assert.equal(validateCustomQuery({ ...definition.query, asOf: '2026-09-30' }).asOf, '2026-09-30')
  assert.throws(() => validateCustomQuery({ ...definition.query, asOf: '2026-02-30' }), /calendar date/)
  assert.throws(() => validateCustomQuery({ ...definition.query, asOf: 20260930 }), /calendar date/)
  const register = BUILT_IN_REPORT_DEFINITION_MAP['equity-securities-register']!
  assert.throws(() => validateCustomQuery({ ...register.query, asOf: '2026-09-30' }), /not read as of a date/)
  const compiled = compileCustomQuery(REPORT_ENTITY_MAP.equity_securities_register!, validateCustomQuery(register.query), ORG)
  assert.doesNotMatch(compiled.text, /::date/, 'period sources carry no as-of bound')
})
