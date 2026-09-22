import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Review/confirm drawer feedback contract (successor to the F-t09-005 and
// F-t07-005 direct-POST call sites, now routed through one drawer):
// - problems + skip counts surface in-drawer AND as toasts on failure;
// - transport/parse failures toast instead of dying silent;
// - a zero-post result names the next due line;
// - reporting-book recognition stays distinct from GL entries;
// - refusal bodies parse only after the res.ok check;
// - no first-party UI outside the drawer posts run-depreciation.
const dir = dirname(fileURLToPath(import.meta.url))
const drawer = readFileSync(join(dir, 'RunDepreciationDrawer.tsx'), 'utf8')

test('the review drawer surfaces the API problem list in Results', () => {
  assert.match(drawer, /result\?\.problems/)
  assert.match(drawer, /\{problems\.map\(/)
})

test('the review drawer names skip counts and per-asset skip reasons', () => {
  assert.match(drawer, /run\.someSkipped/)
  assert.match(drawer, /resultsSkipped/)
  assert.match(drawer, /skipped\.reason/)
})

test('the review drawer toasts transport and parse failures instead of dying silent', () => {
  const preview = drawer.slice(drawer.indexOf('async function runPreview'))
  assert.match(preview, /catch \{[^}]*toast\.error/s)
  const confirm = drawer.slice(drawer.indexOf('async function confirm('))
  assert.match(confirm, /catch \{[^}]*toast\.error/s)
})

test('a zero-post result explains itself with the next due line', () => {
  assert.match(drawer, /result\.nextDue/)
  assert.match(drawer, /run\.nextDue/)
})

test('Results distinguishes reporting-book recognition from GL entries', () => {
  assert.match(drawer, /result\.recorded/)
  assert.match(drawer, /run\.recorded/)
  assert.match(drawer, /result\.recordedAmount/)
  assert.match(drawer, /<JournalEntryLink/)
  assert.match(drawer, /resultsRecorded/)
})

test('the drawer reads refusal bodies only after checking the response', () => {
  const refusal = drawer.slice(drawer.indexOf('async function refusalText'))
  assert.ok(refusal.includes('await res.json()'), 'refusal bodies parse in one place')
  for (const call of [
    '/api/assets/depreciation-preview',
    '/api/assets/run-depreciation',
    '/api/assets/rebuild-schedules',
  ]) {
    const at = drawer.indexOf(`'${call}'`)
    assert.ok(at > -1, `${call} must be called`)
    const after = drawer.slice(at)
    const guard = after.indexOf('if (!res.ok)')
    assert.ok(guard > -1 && guard < 800, `res.ok must precede parsing ${call}`)
  }
})

test('Confirm is disabled while any in-scope schedule is stale', () => {
  assert.match(drawer, /staleBlocked/)
  assert.match(drawer, /disabled=\{confirmBlocked\}/)
  assert.match(drawer, /staleAssets\.length.*> 0/)
  assert.match(drawer, /review\.staleRefusal/)
})

test('no first-party UI outside the review drawer posts run-depreciation', () => {
  const entries = readdirSync(dir).filter(
    (file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'),
  )
  const posters = entries.filter((file) => {
    if (file === 'RunDepreciationDrawer.tsx') return false
    return readFileSync(join(dir, file), 'utf8').includes('/api/assets/run-depreciation')
  })
  assert.deepEqual(posters, [])
})
