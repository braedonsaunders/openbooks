import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const tabSource = readFileSync(
  fileURLToPath(new URL('./drivers-tab.tsx', import.meta.url)),
  'utf8',
)

test('drivers loading renders house skeletons, never a bare ellipsis', () => {
  // Coordinator verdict: two literal '…' loading states. House loading is
  // the shared Skeleton (audit-trail/account-register precedent).
  assert.ok(!tabSource.includes(`'\u2026'`) && !tabSource.includes('{error ??'), 'no bare-ellipsis loading')
  assert.match(tabSource, /<Skeleton/)
})

test('drivers list follows the departments composition', () => {
  // Blurb + New action row, then the search toolbar with the shared
  // show-inactive pill, then the table — headers plus one empty row when
  // there are no drivers, never an EmptyState card.
  assert.ok(!tabSource.includes('<EmptyState'), 'no EmptyState card')
  assert.match(tabSource, /emptyAsRow/)
  assert.match(tabSource, /toolbarAfter/)
  assert.match(tabSource, /ShowInactivePill/)
  // The single empty row carries the short empty copy (no card, no echo).
  assert.ok(tabSource.includes(`{t('empty')}`), 'empty row renders the empty copy')
  // RatesTab depth: blurb + action, no restated h2.
  assert.ok(!tabSource.includes('<h2'), 'no section h2 above the list')
  // The header New action creates through one shared form.
  assert.ok((tabSource.match(/setEditing\(\{ form: newDriverForm\(\) \}\)/g) ?? []).length >= 1, 'header action creates')
})

test('manual values live inside the driver drawer, not behind a ghost button', () => {
  // The values grid is a section of the driver drawer: on edit it renders
  // with the driver; on create the drawer explains values unlock after save
  // and auto-opens the section right after the POST returns the id.
  assert.match(tabSource, /<ManualValuesSection/)
  assert.match(tabSource, /valuesTitle/)
  assert.match(tabSource, /manualCreateHint/)
  assert.match(tabSource, /valuesAfterSave/)
  assert.match(tabSource, /justSavedManual/)
  assert.ok(!tabSource.includes('setValuesFor'), 'no separate values drawer state')
  assert.ok(!tabSource.includes('valuesFor'), 'no separate values drawer state')
})

test('drivers tab uses shared chrome and namespaced action labels', () => {
  assert.match(tabSource, /<Badge variant=/)
  assert.match(tabSource, /<Table>/)
  assert.ok(!tabSource.includes('<table'), 'no hand-rolled tables')
  assert.match(tabSource, /sm:grid-cols-2/)
  assert.ok(!tabSource.includes('grid grid-cols-2 '), 'no orphaned two-column grids')
  assert.ok(tabSource.includes('CHECKBOX_CLASS'), 'checkboxes share one styled class')
  // Common action labels resolve under actions.* — a bare tc('save') renders
  // the raw key path.
  for (const key of ['save', 'cancel', 'close', 'delete', 'add', 'remove', 'saving']) {
    assert.ok(!tabSource.includes(`tc('${key}')`), `no bare tc('${key}')`)
  }
  assert.ok(tabSource.includes(`tc('actions.save')`), 'save resolves through actions.*')
  // Show-inactive uses the shared toggle pill chrome, never a bare checkbox row.
  // No body heading restating the drawer title; the description field
  // carries its own label, never the tab description sentence.
  assert.ok(!tabSource.includes(`title={t('editDriver')}`), 'no Edit-driver body heading')
  assert.ok(tabSource.includes(`label={t('fieldDescription')}`), 'description field has its own label')
  assert.match(tabSource, /headerActions=/)
  assert.ok(!tabSource.includes('footer={'), 'no inline Save/Cancel footer — the header owns Save')
  // Show-inactive is the shared pill component (same chrome as the entity
  // lists), never a bare checkbox row.
  assert.match(tabSource, /<ShowInactivePill checked=\{showInactive\}/)
  assert.ok(!tabSource.includes('<Check checked={showInactive}'), 'no bare show-inactive checkbox')
})
