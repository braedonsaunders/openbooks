import assert from 'node:assert/strict'
import test from 'node:test'

import { majorToMinor, minorToMajor } from './money-fields.ts'

test('a normal USD amount round-trips between majors and minors', () => {
  assert.deepEqual(majorToMinor('120.50', 2), { ok: true, minor: '12050' })
  assert.equal(minorToMajor('12050', 2), '120.50')
  assert.equal(minorToMajor(12050, 2), '120.50')
})

test('a three-place BHD amount keeps its fils', () => {
  assert.deepEqual(majorToMinor('1.234', 3), { ok: true, minor: '1234' })
  assert.equal(minorToMajor('1234', 3), '1.234')
})

test('whole units and zero-exponent currencies need no fraction', () => {
  assert.deepEqual(majorToMinor('40', 2), { ok: true, minor: '4000' })
  assert.deepEqual(majorToMinor('40', 0), { ok: true, minor: '40' })
  assert.equal(minorToMajor('40', 0), '40')
})

test('over-precise fractions refuse instead of rounding', () => {
  assert.deepEqual(majorToMinor('12.345', 2), { ok: false, reason: 'too-precise' })
})

test('non-numeric and negative text refuses instead of coercing', () => {
  assert.deepEqual(majorToMinor('12,34', 2), { ok: false, reason: 'not-a-number' })
  assert.deepEqual(majorToMinor('-5', 2), { ok: false, reason: 'not-a-number' })
  assert.deepEqual(majorToMinor('', 2), { ok: false, reason: 'not-a-number' })
  assert.equal(minorToMajor('nope', 2), null)
})
