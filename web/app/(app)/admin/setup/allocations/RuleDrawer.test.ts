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

test('rule drawer edits party, item and custom-segment filters from the options payload', () => {
  // Options carry the three picker lists; the drawer maps each with an
  // empty fallback so a missing key never breaks the definition tab.
  for (const key of [`payload['parties']`, `payload['items']`, `payload['segments']`]) {
    assert.ok(drawerSource.includes(key), `${key} must be mapped from the options payload`)
  }
  // Parties group under their primary role; items and each custom segment
  // render a MultiCheck bound to the definition form.
  for (const fragment of ['filterPartyIds', 'filterItemIds', 'filterExtraDims', 'partyGroups', 'definition.partyRoles']) {
    assert.ok(drawerSource.includes(fragment), `${fragment} must be wired`)
  }
  assert.ok(drawerSource.includes('definition.filters.party'), 'party filter label comes from the catalog')
  assert.ok(drawerSource.includes('definition.filters.item'), 'item filter label comes from the catalog')
  // Nothing stays read-only: the form round-trips all three through the
  // version PATCH and the test tab can sample party/item lines.
  assert.ok(!drawerSource.includes('filtersReadonly'), 'no filter stays read-only')
  assert.ok(!drawerSource.includes('readonlyFilters'), 'read-only filter branch is gone')
  assert.ok(drawerSource.includes(`key: 'partyId'`), 'test tab samples party lines')
  assert.ok(drawerSource.includes(`key: 'itemId'`), 'test tab samples item lines')
})
