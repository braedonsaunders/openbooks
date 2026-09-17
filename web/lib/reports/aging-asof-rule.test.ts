import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    return next(s, c)
  },
})
const { resolveAgingAsOf } = await import('./aging.ts')

// F-t02-008 / F-t07-011: the aging CSV disagreed with its screen because
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
