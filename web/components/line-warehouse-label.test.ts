import assert from 'node:assert/strict'
import test from 'node:test'
import messages from '../messages/en'

// pickers: both drawers label the warehouse column through
// common.labels.warehouse — a missing key leaks a raw key into the grid
// (the class of defect). Catalog parity checks its translations.
test('the line warehouse picker has human-readable English copy', () => {
  const label = messages.common.labels.warehouse
  assert.ok(label?.trim(), 'English common.labels.warehouse must be present')
  if (!label) return
  assert.notEqual(label, 'warehouse', 'the picker must not show its raw key')
  assert.ok(!label.includes('.'), 'the picker label must not be a dotted message key')
})
