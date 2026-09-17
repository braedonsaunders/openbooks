import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

// F-t08-007: the post response must carry party-less control legs as a typed
// warning — the entry posts (the legs are legitimate GL activity) but never
// silently. The drawer pins the warning; the aging carries the balance.
test('a posted journal reports partyless control legs as warnings', () => {
  assert.match(
    source,
    /partylessControlLines/,
    'the post handler must run party-less control detection after postDocument succeeds',
  )
  assert.match(
    source,
    /code: 'partyless_control_lines'/,
    'the warning must carry a stable typed code the drawer can branch on',
  )
  assert.match(
    source,
    /warnings: outcome\.warnings/,
    'the post response must carry the warnings alongside the entry id',
  )
})
