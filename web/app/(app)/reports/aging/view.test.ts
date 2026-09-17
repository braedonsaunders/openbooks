import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t07-011: the Export button built its URL from the raw page params, so
// the screen's resolved as-of never reached the endpoint — the CSV aged as
// of the fiscal year end while the screen showed today. The loader must
// carry its resolved as-of into the export params.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('aging export params carry the screen-resolved as-of (F-t07-011)', () => {
  assert.match(
    source,
    /exportParams: stringParams\(\{ \.\.\.sp, asOf \}\)/,
    'exportParams must include the resolved asOf, not just the raw page params',
  )
})
