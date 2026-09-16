import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const tabSource = readFileSync(
  fileURLToPath(new URL('./drivers-tab.tsx', import.meta.url)),
  'utf8',
)

test('drivers header keeps New visible and empty tenants get an EmptyState action', () => {
  // Braedon verdict: the create form promised manual values "below" while the
  // grid hid behind a ghost button, and empty tenants had no clear create
  // path. The New action lives in the section header; the empty slot is the
  // shared EmptyState with the same New-driver primary action.
  assert.match(tabSource, /<EmptyState/)
  assert.match(tabSource, /emptyTitle/)
  assert.match(tabSource, /drivers\.length === 0/)
  const creates = tabSource.match(/setEditing\(\{ form: newDriverForm\(\) \}\)/g) ?? []
  assert.ok(creates.length >= 2, 'header and empty-state actions must both create')
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
})
