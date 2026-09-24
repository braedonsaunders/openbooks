import assert from 'node:assert/strict'
import test from 'node:test'
import { shortDate } from './sections'

// F3-16: the payroll home formatted its dates with a hard-coded en-US
// locale, so every operator read American month/day order. The loader now
// passes the operator locale through; the formatter honors it.
test('short dates follow the operator locale', () => {
  assert.equal(shortDate('2026-09-30', 'en'), 'Sep 30')
  assert.match(shortDate('2026-09-30', 'de'), /Sept/)
  assert.notEqual(shortDate('2026-09-30', 'de'), shortDate('2026-09-30', 'en'))
})

test('short dates do not depend on the server time zone', () => {
  // A UTC-midnight instant stays September 30 on both sides of the ocean.
  assert.equal(shortDate('2026-01-05', 'en'), 'Jan 5')
  assert.equal(shortDate('2026-12-31', 'en'), 'Dec 31')
})
