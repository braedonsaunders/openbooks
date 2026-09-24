import assert from 'node:assert/strict'
import test from 'node:test'
import { initialDrawerMode } from './drawer-mode.ts'


test('new editable transactions may open in edit mode', () => {
  assert.equal(initialDrawerMode('edit', true), 'edit')
})

test('edit intent cannot override lifecycle or permission enforcement', () => {
  assert.equal(initialDrawerMode('edit', false), 'view')
  assert.equal(initialDrawerMode('view', true), 'view')
  assert.equal(initialDrawerMode(undefined, true), 'view')
})

// The Parties/Projects/Orders slices open unsaved-create drawers
// (?partyNew=1 / ?projectNew=1 / ?estimateNew=1 / ?orderNew=1) instead of
// persisted drafts, so their entry points carry no mode=edit param — the
// marker IS the intent, and the drawers start in edit mode through
// createMode. Same property (creation opens editable), carried end to end:
// entry marker, loader create mode, drawer edit default.
