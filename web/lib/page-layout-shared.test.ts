import assert from 'node:assert/strict'
import test from 'node:test'
import { mergePageLayouts, orderPanels } from './page-layout-shared'

// The 409-reconcile helper for per-user page layouts: two writers that
// collide must end on the UNION of their hides, never on one tab silently
// dropping the other's.
test('merge unions hidden sets from both tabs', () => {
  assert.deepEqual(mergePageLayouts({ hidden: ['a'] }, { hidden: ['b'] }), {
    hidden: ['a', 'b'],
  })
})

test('merge keeps the local order and appends server-only keys in server order', () => {
  assert.deepEqual(
    mergePageLayouts(
      { order: ['a', 'b', 'c'], hidden: ['c'] },
      { order: ['b', 'a'], hidden: ['a'] },
    ),
    { order: ['b', 'a', 'c'], hidden: ['c', 'a'] },
  )
})

test('merge of two resets is a reset', () => {
  assert.deepEqual(mergePageLayouts({}, {}), {})
})

test('merge deduplicates keys hidden on both sides', () => {
  assert.deepEqual(mergePageLayouts({ hidden: ['a', 'b'] }, { hidden: ['b', 'c'] }), {
    hidden: ['a', 'b', 'c'],
  })
})

test('orderPanels still appends unknown saved keys after new panels', () => {
  assert.deepEqual(orderPanels(['a', 'b', 'c'], { order: ['c', 'a'], hidden: ['b'] }), [
    'c',
    'a',
    'b',
  ])
})
