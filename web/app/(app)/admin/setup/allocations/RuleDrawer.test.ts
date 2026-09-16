import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const drawerSource = readFileSync(fileURLToPath(new URL('./RuleDrawer.tsx', import.meta.url)), 'utf8')

test('rule drawer is URL-state chrome over the rule APIs', () => {
  // UrlDrawer: open state comes from `?rule=`, close returns to the list.
  assert.match(drawerSource, /<UrlDrawer/)
  assert.ok(drawerSource.includes('closeHref'), 'close returns to the list URL')
  assert.ok(drawerSource.includes('open'), 'drawer opens from the ?rule= param')
  // All four tabs render from the catalog.
  for (const tab of ['general', 'definition', 'versions', 'test']) {
    assert.ok(drawerSource.includes(`drawer.tabs.${tab}`), `${tab} tab must exist`)
  }
  // Labels come from the catalog — never literals, never dynamic keys.
  assert.ok(!/t\(`[^`]*\$\{/.test(drawerSource), 'no dynamic i18n keys')
})

test('rule drawer wires every rule endpoint with revision tokens', () => {
  for (const fragment of [
    '/api/allocations/rules/${',
    '/versions/${',
    '/publish',
    '/retire',
    '/targets',
    '/test-match',
    '/api/allocations/options',
    '/api/allocations/drivers',
  ]) {
    assert.ok(drawerSource.includes(fragment), `${fragment} must be wired`)
  }
  // Every write carries the revision token; stale revisions surface errors.stale.
  assert.ok(drawerSource.includes('expectedRevision'), 'writes carry expectedRevision')
  assert.ok(drawerSource.includes('errors.stale'), 'stale revisions surface errors.stale')
})

test('rule drawer edits explicit targets in the shared lines editor', () => {
  assert.match(drawerSource, /<SplitLinesEditor/)
  assert.match(drawerSource, /allowEmptyAccount/)
  assert.match(drawerSource, /showLabel/)
  // Destructive/transition writes confirm first (publish) or carry a reason (retire).
  assert.match(drawerSource, /confirmDialog/)
  assert.ok(drawerSource.includes('drawer.publishConfirm'), 'publish confirms first')
  assert.ok(drawerSource.includes('/retire'), 'retire posts a reason')
})

test('rule drawer create mode posts a head and navigates to the new rule', () => {
  assert.ok(drawerSource.includes(`drawer.newTitle`), 'create mode has a title')
  assert.ok(drawerSource.includes(`?rule=`), 'create navigates to ?rule=<id>')
})
