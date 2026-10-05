import assert from 'node:assert/strict'
import test from 'node:test'

import { majorToMinor, minorToMajor } from './money-fields.ts'

test('a normal USD amount round-trips between majors and minors', () => {
  assert.equal(majorToMinor('120.50', 2), '12050')
  assert.equal(minorToMajor('12050', 2), '120.50')
  assert.equal(minorToMajor(12050, 2), '120.50')
})

test('a three-place BHD amount keeps its fils', () => {
  assert.equal(majorToMinor('1.234', 3), '1234')
  assert.equal(minorToMajor('1234', 3), '1.234')
})

test('whole units and zero-exponent currencies need no fraction', () => {
  assert.equal(majorToMinor('40', 2), '4000')
  assert.equal(majorToMinor('40', 0), '40')
  assert.equal(minorToMajor('40', 0), '40')
})

test('anything the shared grammar refuses converts to null for the classifier remedy', () => {
  // Over-precise fractions, decimal commas, ambiguous commas, thousands
  // separators and non-numeric text all refuse here; the drawer renders the
  // engine classifier's precise remedy for each instead of rounding.
  assert.equal(majorToMinor('12.345', 2), null)
  assert.equal(majorToMinor('12,34', 2), null)
  assert.equal(majorToMinor('1,234', 2), null)
  assert.equal(majorToMinor('1.234,56', 2), null)
  assert.equal(majorToMinor('1,234.56', 2), null)
  assert.equal(majorToMinor('', 2), null)
  assert.equal(minorToMajor('nope', 2), null)
})
