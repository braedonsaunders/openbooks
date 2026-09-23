import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { getSource } from '../src/catalog'
import { compileInsightQuery, insightQueryReferencesBook } from '../src/compile'

const PRIMARY = '00000000-0000-4000-8000-000000000011'
const TAX = '00000000-0000-4000-8000-000000000022'
const SUB = '00000000-0000-4000-8000-000000000033'

test('the insight catalog carries the report book and currency boundaries', () => {
  const ledger = getSource('ledger_lines')
  assert.ok(ledger, 'ledger_lines has no insight source')
  assert.equal(ledger.bookScope?.column, REPORT_ENTITY_MAP.ledger_lines!.bookScope?.column)
  assert.equal(ledger.bookScope?.column, 'je.book_id')
  assert.equal(ledger.currencyColumn, 'currency')
  assert.equal(ledger.baseCurrencyColumn, 'base_currency')
  // Book-independent sources stay book-agnostic like the report executor.
  assert.equal(getSource('documents')?.bookScope, undefined)
  assert.equal(getSource('transaction_lines')?.bookScope, undefined)
})

test('a book allowlist clamps ledger queries without touching user filters', () => {
  const compiled = compileInsightQuery(
    {
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
      filters: [{ field: 'account_type', op: 'in', value: ['income'] }],
    },
    'org-1',
    {},
    '2026-09-18',
    [SUB],
    [PRIMARY],
  )
  assert.match(compiled.sql, /jl\.org_id = \$1/)
  assert.match(compiled.sql, /jl\.subsidiary_id = ANY\(\$2::uuid\[\]\)/)
  assert.match(compiled.sql, /je\.book_id = ANY\(\$3::uuid\[\]\)/)
  assert.deepEqual(compiled.params.slice(0, 3), ['org-1', [SUB], [PRIMARY]])
})

test('an empty book allowlist matches nothing; an absent one leaves the basis alone', () => {
  const q = { source: 'ledger_lines', measures: [{ agg: 'sum', field: 'amount' }] }
  assert.match(
    compileInsightQuery(q, 'org-1', {}, '2026-09-18', null, []).sql,
    /FALSE/,
  )
  // The clamp predicate is `je.book_id = ANY(...)` — a bare /book_id/ also
  // matches the entity FROM clause's accounting_books join, so assert on the
  // predicate, not the column name.
  assert.doesNotMatch(
    compileInsightQuery(q, 'org-1', {}, '2026-09-18', null, undefined).sql,
    /je\.book_id = ANY/,
  )
  assert.doesNotMatch(
    compileInsightQuery(q, 'org-1', {}, '2026-09-18', null, null).sql,
    /je\.book_id = ANY/,
  )
})

test('the book allowlist is ignored by book-independent entities', () => {
  const compiled = compileInsightQuery(
    { source: 'documents', measures: [{ agg: 'sum', field: 'total' }] },
    'org-1',
    {},
    '2026-09-18',
    null,
    [PRIMARY],
  )
  assert.doesNotMatch(compiled.sql, /book_id/)
})

test('explicit book scoping lifts the default; anything else keeps it', () => {
  assert.equal(
    insightQueryReferencesBook({ source: 'ledger_lines', measures: [{ agg: 'sum', field: 'amount' }] }),
    false,
  )
  assert.equal(
    insightQueryReferencesBook({
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      dimensions: [{ field: 'posting_date', bin: 'month' }],
    }),
    false,
  )
  assert.equal(
    insightQueryReferencesBook({
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      filters: [{ field: 'book_id', op: 'eq', value: TAX }],
    }),
    true,
  )
  assert.equal(
    insightQueryReferencesBook({
      source: 'ledger_lines',
      measures: [{ agg: 'sum', field: 'amount' }],
      dimensions: [{ field: 'book' }],
    }),
    true,
    'grouping by book partitions across books, so the primary default must lift',
  )
  assert.equal(
    insightQueryReferencesBook({
      source: 'documents',
      measures: [{ agg: 'sum', field: 'total' }],
    }),
    false,
  )
})
