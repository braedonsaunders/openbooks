import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REPORT_AS_OF, REPORT_ENTITIES, REPORT_ENTITY_MAP, reportEntityForFeatureState } from './entities'
import { compileCustomQuery } from './custom-query'

test('items report kind options drop inventory kinds when Inventory is off', () => {
  const items = REPORT_ENTITY_MAP.items
  assert.ok(items)
  const hidden =
    reportEntityForFeatureState(items, { inventory: false }).columns.find((column) => column.key === 'kind')
      ?.options ?? []
  assert.deepEqual(
    hidden.filter((value) => ['inventory', 'assembly', 'kit'].includes(value)),
    [],
  )
  const shown =
    reportEntityForFeatureState(items, { inventory: true }).columns.find((column) => column.key === 'kind')
      ?.options ?? []
  assert.ok(shown.includes('inventory') && shown.includes('assembly') && shown.includes('kit'))
  assert.ok(
    items.columns.find((column) => column.key === 'kind')?.options?.includes('inventory'),
    'the static catalog keeps inventory kinds for existing rows and saved filters',
  )
})

test('entitlement_balances limit as-of is the catalog sentinel, not CURRENT_DATE', () => {
  const from = REPORT_ENTITY_MAP.entitlement_balances!.from
  assert.match(from, new RegExp(REPORT_AS_OF))
  assert.doesNotMatch(from, /CURRENT_DATE/)
})

test('inventory lot movements are inventory-gated, unperioded traceability history', () => {
  const entity = REPORT_ENTITY_MAP.inventory_lot_movements
  assert.ok(entity)
  assert.equal(entity.featureKey, 'inventory')
  assert.equal(entity.defaultPeriodField, null)
  assert.deepEqual(entity.pagination, { defaultPageSize: 100, maxPageSize: 500 })
  assert.equal(entity.cellLinks?.[0]?.column, 'document_number')
})

test('allocation run and lineage entities are allocations-gated with org-pinned joins', () => {
  assert.ok(REPORT_ENTITIES.some((entity) => entity.key === 'allocation_runs'))
  assert.ok(REPORT_ENTITIES.some((entity) => entity.key === 'allocation_lineage'))
  const runs = REPORT_ENTITY_MAP.allocation_runs!
  assert.equal(runs.requiredPermission, 'allocations.read')
  assert.equal(runs.featureKey, 'allocations')
  assert.equal(runs.orgColumn, 'r.org_id')
  // Runs are per-book: the standard omitted-book contract clamps to the
  // primary book unless the plan scopes or partitions by a book column.
  assert.deepEqual(runs.bookScope, { column: 'r.book_id' })
  const runJoins = runs.from.split('\n').filter((line) => /\bJOIN\b/i.test(line))
  assert.ok(runJoins.length >= 4, 'runs join rules, versions, periods, and books')
  for (const join of runJoins) {
    assert.match(join, /\borg_id\s*=\s*r\.org_id\b/i, join.trim())
  }
  const lineage = REPORT_ENTITY_MAP.allocation_lineage!
  assert.equal(lineage.requiredPermission, 'allocations.read')
  assert.equal(lineage.featureKey, 'allocations')
  assert.equal(lineage.orgColumn, 'l.org_id')
  // Entry/post lineage has no run or journal line; GL-only lineage has no
  // period context — every join past rules/versions is outer.
  const lineageJoins = lineage.from.split('\n').filter((line) => /\bJOIN\b/i.test(line))
  assert.ok(lineageJoins.length >= 6, 'lineage joins rules, versions, runs, periods, books, accounts, dimensions')
  for (const join of lineageJoins) {
    assert.match(join, /\borg_id\s*=\s*l\.org_id\b/i, join.trim())
  }
  assert.match(lineage.from, /allocation_rule_versions/i)
  assert.match(lineage.from, /accounting_periods/i)
  assert.match(lineage.from, /accounting_books/i)

  const compiled = compileCustomQuery(runs, {
    entity: runs.key,
    mode: 'rows',
    columns: ['rule_name'],
    filters: null,
    limit: 10,
  }, '00000000-0000-4000-8000-000000000001')
  assert.match(compiled.text, /WHERE r\.org_id = \$1/)
  assert.deepEqual(compiled.values, ['00000000-0000-4000-8000-000000000001'])
})

test('every inventory lot movement join is pinned to the base organization', () => {
  const entity = REPORT_ENTITY_MAP.inventory_lot_movements!
  const joins = entity.from.split('\n').filter((line) => /\bJOIN\b/i.test(line))
  assert.equal(joins.length, 6)
  for (const join of joins) {
    assert.match(join, /\borg_id\s*=\s*im\.org_id\b/i, join.trim())
  }
  assert.match(entity.from, /it\.id\s*=\s*lot\.item_id/)

  const compiled = compileCustomQuery(entity, {
    entity: entity.key,
    mode: 'rows',
    columns: ['lot_number'],
    filters: null,
    limit: 10,
  }, '00000000-0000-4000-8000-000000000001')
  assert.match(compiled.text, /WHERE im\.org_id = \$1/)
  assert.deepEqual(compiled.values, ['00000000-0000-4000-8000-000000000001'])
})
