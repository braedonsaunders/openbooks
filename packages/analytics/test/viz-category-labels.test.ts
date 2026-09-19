import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVizSpec } from '../src/viz.ts'
import type { QueryResult, ResultColumn } from '../src/types.ts'

const monthCol: ResultColumn = {
  key: 'posting_date_month',
  label: 'Posting date (month)',
  type: 'date',
  role: 'dimension',
  dateBin: 'month',
}
const measureCol: ResultColumn = { key: 'sum_credit', label: 'Revenue', type: 'currency', role: 'measure' }

const result = (rows: Record<string, unknown>[]): QueryResult => ({
  columns: [monthCol, measureCol],
  rows,
  rowCount: rows.length,
  truncated: false,
  durationMs: 1,
})

function categoriesOf(rows: Record<string, unknown>[]): string[] {
  const spec = buildVizSpec(result(rows), 'line', {})
  assert.equal(spec.kind, 'chart')
  const option = (spec as { option: Record<string, unknown> }).option
  return ((option.xAxis as { data: string[] }).data)
}

test('a month bucket is labelled as the period, from the string a JSON fetch delivers', () => {
  // Every dashboard card fetches over HTTP and parses with res.json(), so the
  // date arrives as a STRING. The old label test was `v instanceof Date`,
  // which is false exactly there — the axis printed 2026-09-01T00:00:00.000Z.
  assert.deepEqual(
    categoriesOf([
      { posting_date_month: '2026-08-01T00:00:00.000Z', sum_credit: '10' },
      { posting_date_month: '2026-09-01T00:00:00.000Z', sum_credit: '20' },
    ]),
    ['Aug 2026', 'Sep 2026'],
  )
})

test('an in-process Date labels identically to its JSON round trip', () => {
  assert.deepEqual(
    categoriesOf([{ posting_date_month: new Date('2026-09-01T00:00:00.000Z'), sum_credit: '20' }]),
    ['Sep 2026'],
  )
})

test('no chart category ever renders a raw timestamp', () => {
  for (const label of categoriesOf([
    { posting_date_month: '2026-09-01T00:00:00.000Z', sum_credit: '1' },
    { posting_date_month: '2026-10-01', sum_credit: '2' },
  ])) {
    assert.doesNotMatch(label, /T\d{2}:\d{2}/, `raw timestamp leaked into a chart label: ${label}`)
    assert.doesNotMatch(label, /\dZ$/, `raw timestamp leaked into a chart label: ${label}`)
  }
})

test('non-temporal categories are untouched', () => {
  const spec = buildVizSpec(
    {
      columns: [{ key: 'account_type', label: 'Type', type: 'category', role: 'dimension' }, measureCol],
      rows: [{ account_type: 'income', sum_credit: '5' }],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
    },
    'bar',
    {},
  )
  assert.equal(spec.kind, 'chart')
  assert.deepEqual(((spec as { option: Record<string, unknown> }).option.xAxis as { data: string[] }).data, ['income'])
})
