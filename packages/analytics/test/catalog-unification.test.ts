import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITIES, REPORT_ENTITY_MAP } from '@openbooks/reports'
import { INSIGHT_SOURCES, getSource, sourcePermission, allowedSources } from '../src/catalog.ts'
import { compileInsightQuery } from '../src/compile.ts'
import { migrateLegacyQuery } from '../src/legacy.ts'
import { validateInsightQuery } from '../src/validate.ts'

/**
 * The insights card studio and the custom report builder query ONE catalog.
 * These tests are what says so: if someone re-authors a source list for either
 * surface, the two stop matching here first.
 */

test('every report entity is an insight source, and nothing else is', () => {
  assert.deepEqual(
    INSIGHT_SOURCES.map((s) => s.key),
    REPORT_ENTITIES.map((e) => e.key),
  )
})

test('every entity column is a queryable field with the same expression', () => {
  for (const entity of REPORT_ENTITIES) {
    const source = getSource(entity.key)
    assert.ok(source, `${entity.key} has no insight source`)
    assert.deepEqual(
      source.fields.map((f) => f.key),
      entity.columns.map((c) => c.key),
      `${entity.key}: field list drifted from the entity columns`,
    )
    for (const column of entity.columns) {
      const field = source.fields.find((f) => f.key === column.key)!
      assert.equal(field.expr, column.expr, `${entity.key}.${column.key}: expression drifted`)
    }
  }
})

test('money and number columns are measurable; text and dates are not', () => {
  const ledger = getSource('ledger_lines')!
  assert.equal(ledger.fields.find((f) => f.key === 'amount')?.canMeasure, true)
  assert.equal(ledger.fields.find((f) => f.key === 'debit')?.canMeasure, true)
  assert.equal(ledger.fields.find((f) => f.key === 'quantity')?.canMeasure, true)
  assert.equal(ledger.fields.find((f) => f.key === 'account_name')?.canMeasure, false)
  assert.equal(ledger.fields.find((f) => f.key === 'posting_date')?.canBin, true)
  // A timestamp column bins like a date, not like a category.
  assert.equal(ledger.fields.find((f) => f.key === 'reconciled_at')?.canBin, true)
})

test('boolean columns carry the value vocabulary the studio and renderer need', () => {
  const parties = getSource('parties')!
  const isCustomer = parties.fields.find((f) => f.key === 'is_customer')!
  assert.equal(isCustomer.valueKind, 'boolean')
  assert.deepEqual([...(isCustomer.options ?? [])], ['true', 'false'])
})

test('payroll sources keep their permission; the rest are open to insights.read', () => {
  assert.equal(sourcePermission('pay_stubs'), 'payroll.read')
  assert.equal(sourcePermission('ledger_lines'), null)
  const withoutPayroll = allowedSources((p) => p !== 'payroll.read').map((s) => s.key)
  assert.ok(!withoutPayroll.includes('pay_stubs'))
  assert.ok(withoutPayroll.includes('ledger_lines'))
  // Same gate as the report builder reads.
  for (const entity of REPORT_ENTITIES) {
    assert.equal(sourcePermission(entity.key), entity.requiredPermission ?? null, entity.key)
  }
})

test("an entity's implicit baseFilter is applied to insight queries too", () => {
  const entity = REPORT_ENTITY_MAP['entitlement_service_milestones']!
  assert.ok(entity.baseFilter, 'fixture entity lost its baseFilter')
  const compiled = compileInsightQuery(
    { source: entity.key, measures: [{ agg: 'count' }], dimensions: [{ field: 'employee' }] },
    'org-1',
  )
  assert.match(compiled.sql, /t\.is_active IS TRUE/)
  assert.equal(compiled.params[0], 'org-1')
})

test('relative date filters bind the org business day, never current_date', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'count' }],
      filters: [
        { field: 'posting_date', op: 'ytd' },
        { field: 'posting_date', op: 'last_n_days', value: 30 },
      ],
    },
    'org-1',
    {},
    '2026-08-21',
  )
  assert.doesNotMatch(compiled.sql, /current_date/i)
  assert.ok(compiled.params.includes('2026-08-21'))
  assert.ok(compiled.params.includes(30))
  assert.match(compiled.sql, /::date/)
})

test('bound parameters stay numbered in order when a baseFilter binds values', () => {
  const compiled = compileInsightQuery(
    {
      source: 'entitlement_service_milestones',
      measures: [{ agg: 'count' }],
      filters: [{ field: 'job_title', op: 'eq', value: 'Foreman' }],
    },
    'org-1',
  )
  // $1 is always the org; every later placeholder maps to its own value.
  assert.equal(compiled.params.length, 2)
  assert.deepEqual(compiled.params, ['org-1', 'Foreman'])
  assert.match(compiled.sql, /= \$2/)
})

test('cards saved against the old insights catalog still resolve', () => {
  const migrated = migrateLegacyQuery({
    source: 'ledger_lines',
    measures: [{ agg: 'sum', field: 'amount' }],
    dimensions: [{ field: 'party' }, { field: 'entry_origin' }],
    filters: [{ field: 'party', op: 'contains', value: 'Acme' }],
  })
  assert.deepEqual(migrated.dimensions?.map((d) => d.field), ['party_name', 'origin'])
  assert.equal(migrated.filters?.[0]?.field, 'party_name')
  // And the whole plan passes validation, which is what the API path does.
  assert.doesNotThrow(() =>
    validateInsightQuery({
      source: 'documents',
      measures: [{ agg: 'sum', field: 'total' }],
      dimensions: [{ field: 'party' }],
    }),
  )
})

test('legacy yes/active filter codes become the boolean literals Postgres parses', () => {
  const migrated = migrateLegacyQuery({
    source: 'parties',
    measures: [{ agg: 'count' }],
    filters: [
      { field: 'is_active', op: 'eq', value: 'active' },
      { field: 'is_customer', op: 'in', value: ['yes', 'no'] },
      { field: 'display_name', op: 'eq', value: 'active' },
    ],
  })
  assert.equal(migrated.filters?.[0]?.value, 'true')
  assert.deepEqual(migrated.filters?.[1]?.value, ['true', 'false'])
  // A text field named with the same word is left alone.
  assert.equal(migrated.filters?.[2]?.value, 'active')
})
