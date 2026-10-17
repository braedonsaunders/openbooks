import assert from 'node:assert/strict'
import test from 'node:test'
import { EQUITY_REPORT_ENTITIES } from './equity-entities'
import { REPORT_ENTITY_MAP } from './entities'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
import { validateCustomQuery } from './validate'
import { compileCustomQuery } from './custom-query'

const ORG = '00000000-0000-4000-8000-000000000001'

test('equity reports are gated by the equity feature and permission, org-bounded and scoped to the legal entity', () => {
  assert.equal(EQUITY_REPORT_ENTITIES.length, 2)
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
