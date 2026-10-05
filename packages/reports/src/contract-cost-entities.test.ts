import assert from 'node:assert/strict'
import test from 'node:test'
import { CONTRACT_COST_REPORT_ENTITIES } from './contract-cost-entities'
import { REPORT_ENTITY_MAP } from './entities'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
import { validateCustomQuery } from './validate'
import { compileCustomQuery } from './custom-query'

test('contract cost reports are native definitions with a tenant boundary', () => {
  assert.equal(CONTRACT_COST_REPORT_ENTITIES.length, 2)
  for (const entity of CONTRACT_COST_REPORT_ENTITIES) {
    assert.equal(REPORT_ENTITY_MAP[entity.key], entity)
    assert.equal(entity.requiredPermission, 'contract_costs.read')
    assert.equal(entity.featureKey, 'contractCosts')
    assert.ok(entity.orgColumn)
    assert.ok(entity.currencyColumn)
    const slug = entity.key.replaceAll('_', '-')
    const definition = BUILT_IN_REPORT_DEFINITION_MAP[slug]
    assert.ok(definition, slug)
    const validated = validateCustomQuery(definition.query)
    const compiled = compileCustomQuery(entity, validated, '00000000-0000-4000-8000-000000000001')
    assert.match(compiled.text, new RegExp(entity.orgColumn.replace('.', '\\.')))
  }
})

test('the roll-forward carries every movement and the postings name their event', () => {
  const rollforward = REPORT_ENTITY_MAP.contract_cost_rollforward!
  for (const key of ['capitalized', 'amortized', 'impaired', 'closing']) {
    const column = rollforward.columns.find((column) => column.key === key)
    assert.ok(column, key)
    assert.equal(column.kind, 'money')
  }
  const postings = REPORT_ENTITY_MAP.contract_cost_postings!
  assert.equal(postings.bookScope?.column, 'je.book_id')
  assert.match(postings.from, /je\.status in \('posted','reversed'\)/)
})
