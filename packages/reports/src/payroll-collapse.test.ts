import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITY_MAP } from './entities'
import { compileCustomQuery } from './custom-query'
import { PAYROLL_RESTRICTED_PARTY_LABEL, payrollRestrictedEntity } from './confidential-entities'

const ORG = '00000000-0000-4000-8000-000000000001'

// Source-level payroll confidentiality (PAYCONF-c/d/e, collapse semantics):
// a restricted reader's ledger_lines compiles against a pre-collapsed grain
// — party-tagged payroll legs aggregated per (entry, account, currency) in
// the entity FROM — so no caller filter, breakout, grouping, sort, or LIMIT
// in any mode can return a pre-collapse per-employee row. Totals tie out by
// construction; granted readers compile the base entity untouched.

const RESTRICTED_MAP = {
  ...REPORT_ENTITY_MAP,
  ledger_lines: payrollRestrictedEntity(REPORT_ENTITY_MAP.ledger_lines!, false),
}

test('granted readers keep the base entity untouched', () => {
  assert.equal(payrollRestrictedEntity(REPORT_ENTITY_MAP.ledger_lines!, true), REPORT_ENTITY_MAP.ledger_lines)
})

test('the restricted entity pre-collapses payroll legs in its FROM', () => {
  const entity = RESTRICTED_MAP.ledger_lines!
  assert.match(entity.from, /UNION ALL/)
  assert.match(entity.from, /GROUP BY/)
  assert.match(entity.from, /pay_run/)
  assert.match(entity.from, new RegExp(PAYROLL_RESTRICTED_PARTY_LABEL.replace(/[()]/g, '\\$&')))
  // Money aggregates; identity is masked.
  assert.match(entity.from, /sum\(jl\.amount\)/)
  // Scope and column keys survive so every caller clause still compiles.
  assert.equal(entity.orgColumn, 'rc."__org_id"')
  assert.equal(entity.subsidiaryScope?.column, 'rc."__subsidiary_id"')
  assert.equal(entity.bookScope?.column, 'rc."__book_id"')
})

test('rows mode compiles against the collapsed grain with no exclusion predicate', () => {
  const entity = RESTRICTED_MAP.ledger_lines!
  const q = {
    entity: 'ledger_lines',
    mode: 'rows',
    columns: ['posting_date', 'party_name', 'amount'],
    limit: 1,
  }
  const compiled = compileCustomQuery(entity, q, ORG, {})
  assert.match(compiled.text, /UNION ALL/)
  assert.doesNotMatch(compiled.text, /NOT \(EXISTS/)
  // The caller's limit still applies — to collapsed rows.
  assert.match(compiled.text, /LIMIT 1/)
})

test('an amount oracle matches only entry totals, never a leg', () => {
  const entity = RESTRICTED_MAP.ledger_lines!
  const q = {
    entity: 'ledger_lines',
    mode: 'rows',
    columns: ['posting_date', 'party_name', 'amount'],
    // Filters apply to the collapsed grain: a leg amount matches nothing
    // there unless some entry totals to exactly that amount.
    filters: { combinator: 'and', rules: [{ field: 'amount', op: 'eq', value: '4842.17' }] },
    limit: 10,
  }
  const compiled = compileCustomQuery(entity, q, ORG, {})
  assert.match(compiled.text, /UNION ALL/)
  // The filter binds the collapsed grain, never a line amount.
  assert.match(compiled.text, /rc\."amount" = /)
})

test('summarize mode groups the collapsed grain', () => {
  const entity = RESTRICTED_MAP.ledger_lines!
  const q = {
    entity: 'ledger_lines',
    mode: 'summarize',
    columns: [],
    breakouts: [{ column: 'amount' }],
    measures: [{ fn: 'count' }],
  }
  const compiled = compileCustomQuery(entity, q, ORG, {})
  assert.match(compiled.text, /UNION ALL/)
  assert.match(compiled.text, /GROUP BY/)
})

test('entities without a collapsible grain compile unchanged', () => {
  assert.equal(payrollRestrictedEntity(REPORT_ENTITY_MAP.documents!, false), REPORT_ENTITY_MAP.documents)
})

test('transaction lines pre-collapse in their FROM too', () => {
  const entity = payrollRestrictedEntity(REPORT_ENTITY_MAP.transaction_lines!, false)
  assert.notEqual(entity, REPORT_ENTITY_MAP.transaction_lines)
  assert.match(entity.from, /UNION ALL/)
  assert.match(entity.from, /GROUP BY/)
  assert.match(entity.from, /pay_run/)
  assert.match(entity.from, /sum\(/)
  assert.equal(entity.orgColumn, 'rc."__org_id"')
})

test('the restricted label names no employee', () => {
  assert.equal(PAYROLL_RESTRICTED_PARTY_LABEL, 'Payroll (restricted)')
})
