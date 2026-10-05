import assert from 'node:assert/strict'
import test from 'node:test'
import { familyTabFromParam } from './family-tabs'

test('family tabs resolve by name and fall back to variants', () => {
  assert.equal(familyTabFromParam('pricing'), 'pricing')
  assert.equal(familyTabFromParam('options'), 'options')
  assert.equal(familyTabFromParam('details'), 'details')
  assert.equal(familyTabFromParam('variants'), 'variants')
})

test('an unknown family tab never strands the drawer', () => {
  assert.equal(familyTabFromParam('matrix'), 'variants')
  assert.equal(familyTabFromParam(null), 'variants')
  assert.equal(familyTabFromParam(undefined), 'variants')
})
