import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t07-011: a bare aging export URL (no as-of, no period) fell through to
// the fiscal year end, so every balance landed in 90+. The endpoint must
// resolve bare hits through the shared aging as-of rule (screen default:
// today), while explicit params keep their meaning.
const source = readFileSync(new URL('./report-run.ts', import.meta.url), 'utf8')

test('aging export resolves bare hits through the shared as-of rule (F-t07-011)', () => {
  assert.match(
    source,
    /resolveAgingAsOf\(\{/,
    'the aging export case must use resolveAgingAsOf, not the fiscal year end fallthrough',
  )
  assert.match(
    source,
    /resolvePeriod\('today'/,
    'bare aging exports must default to today like the screen',
  )
})
