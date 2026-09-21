import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t09-005 residual: a run that posts 0 on a closed GL period showed no
// feedback — the drawer never surfaced the API's `problems` list or the
// skip count, and a transport/parse failure died silently inside
// try/finally (or an uncaught rejection). Both run call sites must surface
// problems + skips and toast every failure.
const drawer = readFileSync(new URL('./AssetDrawer.tsx', import.meta.url), 'utf8')
const button = readFileSync(new URL('./RunDepreciationButton.tsx', import.meta.url), 'utf8')

const runForAsset = drawer.slice(drawer.indexOf('async function runForAsset'))

test('the drawer run surfaces the API problem list as warnings', () => {
  assert.match(runForAsset, /data\.problems/)
  assert.match(runForAsset, /toast\.warning/)
})

test('the drawer run names the skip count instead of a bare nothing-due', () => {
  assert.match(runForAsset, /someSkipped/)
})

test('the drawer run toasts transport and parse failures instead of dying silent', () => {
  assert.match(runForAsset, /catch \{[^}]*toast\.error/s)
})

test('the page-level run toasts transport and parse failures instead of dying silent', () => {
  const run = button.slice(button.indexOf('async function run('))
  assert.match(run, /catch \{[^}]*toast\.error/s)
})

// F-t07-005: a mid-period run posts 0 with 0 skipped and an empty problems
// list while a planned line waits in the open current period —
// "Nothing due to depreciate" misreads the record. Both call sites must
// render the engine's next-due explanation (as-of date, next asset/period,
// amount, period end) when the run names one.
test('both run call sites explain a zero-post run with its next due line', () => {
  assert.match(runForAsset, /data\.nextDue/)
  assert.match(runForAsset, /run\.nextDue/)
  const run = button.slice(button.indexOf('async function run('))
  assert.match(run, /data\.nextDue/)
  assert.match(run, /run\.nextDue/)
})


test('both native run controls distinguish reporting-book recognition from GL entries', () => {
  for (const source of [runForAsset, button]) {
    assert.match(source, /data\.recorded/)
    assert.match(source, /run\.recorded/)
    assert.match(source, /data\.recordedAmount/)
    assert.match(source, /posted > 0 \|\| recorded > 0/)
    assert.ok(source.indexOf('if (!res.ok)') < source.indexOf('data = await res.json()'))
    assert.match(source, /readApiErrorMessage/)
  }
  assert.doesNotMatch(drawer, /payload\.books\.filter\(\(book\) => book\.postsGl\)/)
})
