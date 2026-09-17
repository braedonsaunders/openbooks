import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

// The fleet probed POST /api/password-reset without browser Origin headers
// and saw the edge CSRF gate's 403 {error:forbidden} for every address —
// while the page unconditionally reported "link is on its way". The 403 is
// the fail-closed gate doing its job (real browsers send Origin and pass;
// login rides the same gate), but the request form must not claim success
// when the request itself failed. Anti-enumeration stays: a reached server
// always answers 200, so only a failed request may surface an error.
test('a failed reset request surfaces an error instead of claiming the link is on its way', () => {
  assert.match(
    source,
    /const res = await fetch\('\/api\/password-reset', \{\s*method: 'POST'/,
    'the request submit must keep the response instead of fire-and-forget',
  )
  assert.match(
    source,
    /if \(!res \|\| !res\.ok\)/,
    'a transport or gate failure (null response / non-2xx) must branch to the error state',
  )
  assert.match(
    source,
    /reset\.requestFailed/,
    'the failure must render localized copy, not a raw status',
  )
  assert.doesNotMatch(
    source,
    /catch\(\(\) => undefined\)\s*\n\s*setDone\(true\)/,
    'success must never be claimed before the response is checked',
  )
})
