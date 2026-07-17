import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleTopNavGroupCount } from './top-nav-overflow'

test('keeps every group visible when the groups fit without More', () => {
  assert.equal(
    visibleTopNavGroupCount({
      availableWidth: 250,
      groupWidths: [60, 70, 80],
      moreWidth: 55,
      gap: 4,
    }),
    3,
  )
})

test('reserves the More trigger before choosing the visible prefix', () => {
  assert.equal(
    visibleTopNavGroupCount({
      availableWidth: 210,
      groupWidths: [60, 70, 80],
      moreWidth: 55,
      gap: 4,
    }),
    2,
  )
})

test('shows only More when no group fits alongside it', () => {
  assert.equal(
    visibleTopNavGroupCount({
      availableWidth: 100,
      groupWidths: [60, 70],
      moreWidth: 55,
      gap: 4,
    }),
    0,
  )
})

test('handles empty and invalid measurements safely', () => {
  assert.equal(
    visibleTopNavGroupCount({
      availableWidth: Number.NaN,
      groupWidths: [],
      moreWidth: Number.POSITIVE_INFINITY,
      gap: -4,
    }),
    0,
  )
})
