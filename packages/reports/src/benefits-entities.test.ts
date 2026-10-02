import assert from 'node:assert/strict'
import test from 'node:test'
import { BENEFITS_REPORT_ENTITIES } from './benefits-entities'
import { REPORT_ENTITY_MAP } from './entities'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
import { validateCustomQuery } from './validate'
import { compileCustomQuery } from './custom-query'

test('benefits reports are native definitions with a tenant and legal-entity boundary', () => {
  for (const entity of BENEFITS_REPORT_ENTITIES) {
    assert.equal(REPORT_ENTITY_MAP[entity.key], entity)
    assert.equal(entity.requiredPermission, 'hrm.benefits.read')
    assert.equal(entity.featureKey, 'hrm')
    assert.ok(entity.orgColumn)
    assert.ok(entity.subsidiaryScope?.column)
    const slug = `workforce-${entity.key.replace(/^hrm_/, '').replaceAll('_', '-')}`
    const definition = BUILT_IN_REPORT_DEFINITION_MAP[slug]
    assert.ok(definition, slug)
    assert.ok(definition.query.columns.includes('currency'), slug)
    assert.ok(definition.query.columns.includes('status'), slug)
    const validated = validateCustomQuery(definition.query)
    const compiled = compileCustomQuery(entity, validated, '00000000-0000-4000-8000-000000000001')
    assert.match(compiled.text, new RegExp(entity.orgColumn.replace('.', '\\.')))
  }
})

test('coverage amounts retain currency and native payroll-run evidence without claiming cash payment', () => {
  const entity = REPORT_ENTITY_MAP.hrm_benefit_payroll_inputs!
  assert.equal(entity.currencyColumn, 'currency')
  assert.equal(entity.columns.find((column) => column.key === 'amount')?.txnCurrency, true)
  assert.equal(entity.columns.find((column) => column.key === 'payroll_run_id')?.expr, 'i.pay_run_document_id')
  assert.equal(entity.defaultPeriodField, 'coverage_from')
  assert.match(entity.from, /p\.org_id = e\.org_id/)
  assert.match(entity.from, /worker\.org_id = emp\.org_id/)
})
