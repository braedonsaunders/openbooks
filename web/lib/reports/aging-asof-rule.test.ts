import assert from 'node:assert/strict'
import test from 'node:test'

const { resolveAgingAsOf } = await import('./aging.ts')

// The aging CSV disagreed with its screen because
// the export fell through to the fiscal year end while the screen ages as
// of today. The as-of shift alone reproduces both totals and buckets.
test('an explicit as-of always wins', () => {
  assert.equal(
    resolveAgingAsOf({ asOf: '2026-09-17', periodParam: 'this_fiscal_year', periodTo: '2026-12-31', today: '2026-09-17' }),
    '2026-09-17',
  )
})

test('an explicit period preset resolves to its own end date', () => {
  assert.equal(
    resolveAgingAsOf({ asOf: null, periodParam: 'last_month', periodTo: '2026-08-31', today: '2026-09-17' }),
    '2026-08-31',
  )
})

test('a bare call defaults to today, never the fiscal year end', () => {
  assert.equal(
    resolveAgingAsOf({ asOf: null, periodParam: null, periodTo: '2026-12-31', today: '2026-09-17' }),
    '2026-09-17',
  )
})
