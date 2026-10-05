import assert from 'node:assert/strict'
import test from 'node:test'
import { PORTFOLIO_SUMMARY_REPORTS } from './portfolio-summaries'
import { OPERATIONAL_REPORT_ENTITIES } from './operational-entities'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
import { REPORT_ENTITY_MAP } from './entities'
import { compileCustomQuery } from './custom-query'
import { validateCustomQuery } from './validate'

const orgId = '00000000-0000-4000-8000-000000000001'
const subsidiaryId = '00000000-0000-4000-8000-000000000002'

test('every portfolio summary is registered as a runnable native report', () => {
  assert.ok(PORTFOLIO_SUMMARY_REPORTS.length >= 8)
  for (const report of PORTFOLIO_SUMMARY_REPORTS) {
    assert.equal(BUILT_IN_REPORT_DEFINITION_MAP[report.slug], report)
    const query = validateCustomQuery(report.query)
    assert.ok(query.measures!.length >= 3 && query.measures!.length <= 4, report.slug)
    assert.equal(query.periodField, null, `${report.slug}: current state must not silently become a fiscal cohort`)
  }
})

test('new operational sources require their native permission and bind org and subsidiary scope', () => {
  const expectedPermissions = { manufacturing_work_orders: 'manufacturing.read', managed_property_portfolio: 'ar.read' }
  for (const entity of OPERATIONAL_REPORT_ENTITIES) {
    assert.equal(entity.requiredPermission, expectedPermissions[entity.key as keyof typeof expectedPermissions])
    assert.ok(entity.featureKey)
    const report = PORTFOLIO_SUMMARY_REPORTS.find((definition) => definition.query.entity === entity.key)!
    const compiled = compileCustomQuery(entity, validateCustomQuery(report.query), orgId, { allowedSubsidiaryIds: [subsidiaryId] })
    assert.ok(compiled.text.includes(entity.orgColumn), entity.key)
    assert.ok(compiled.text.includes(entity.subsidiaryScope!.column), entity.key)
    assert.ok(compiled.values.includes(orgId), 'organization must be a bound parameter')
    assert.ok(compiled.values.some((value) => Array.isArray(value) && value.includes(subsidiaryId)), 'legal entity must be a bound allowlist')
    const denied = compileCustomQuery(entity, report.query, orgId, { allowedSubsidiaryIds: [] })
    assert.match(denied.text, /FALSE/, 'an empty legal-entity grant must return no rows')
  }
})

test('snapshot opt-out is preserved and invalid period fields name the remedy', () => {
  const base = PORTFOLIO_SUMMARY_REPORTS.find((report) => report.query.entity === 'projects')!.query
  assert.equal(validateCustomQuery(base).periodField, null)
  assert.equal(validateCustomQuery({ ...base, periodField: 'starts_on' }).periodField, 'starts_on')
  assert.throws(() => validateCustomQuery({ ...base, periodField: 'status' }), /date column.*null for a current-state report/)
  assert.throws(() => validateCustomQuery({ ...base, periodField: 'foreign_date' }), /date column/)
})

test('payroll money retains its immutable pay-stub currency in every aggregate', () => {
  const entity = REPORT_ENTITY_MAP.pay_stubs!
  assert.equal(entity.currencyColumn, 'currency')
  assert.equal(entity.columns.find((column) => column.key === 'currency')?.expr, 's.currency_code')
  const money = entity.columns.filter((column) => column.kind === 'money')
  assert.ok(money.length > 3)
  for (const column of money) assert.equal(column.txnCurrency, true, column.key)
  const report = BUILT_IN_REPORT_DEFINITION_MAP['payroll-cost-by-month']!
  const compiled = compileCustomQuery(entity, validateCustomQuery({ ...report.query, filters: { combinator: 'and', rules: [
    { field: 'pay_date', op: 'gte', value: '2026-01-01' },
    { field: 'pay_date', op: 'lte', value: '2026-12-31' },
  ] } }), orgId)
  assert.match(compiled.text, /s\.currency_code/)
  assert.equal(compiled.hasDenominationCensus, true, 'a monthly sum must observe real source denominations')
})
