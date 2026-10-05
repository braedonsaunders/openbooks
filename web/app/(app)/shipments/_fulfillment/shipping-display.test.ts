// Behaviour of the shipment drawer shipping helpers: minor-unit label cost
// renders as exact major units without floats, and unusable input reads as
// null instead of a wrong amount. Bulk totals add exact rate decimals.
import assert from 'node:assert/strict'
import test from 'node:test'
import { addExact, minorToMajor } from './shipping-display.ts'

test('minor label cost renders as exact major units', () => {
  assert.equal(minorToMajor('1045', 'USD'), '10.45')
  assert.equal(minorToMajor('5', 'USD'), '0.05')
  assert.equal(minorToMajor('100', 'JPY'), '100')
  assert.equal(minorToMajor('-250', 'USD'), '-2.50')
  assert.equal(minorToMajor('00100', 'USD'), '1.00')
})

test('unusable minor input reads as null, never a wrong amount', () => {
  assert.equal(minorToMajor('', 'USD'), null)
  assert.equal(minorToMajor('10.45', 'USD'), null)
  assert.equal(minorToMajor('abc', 'USD'), null)
  assert.equal(minorToMajor('12,34', 'USD'), null)
})

test('bulk totals add exact rate decimals without floats', () => {
  assert.equal(addExact('10.45', '0.05'), '10.50')
  assert.equal(addExact('9.9', '0.105'), '10.005')
  assert.equal(addExact('0', '0'), '0')
})

test('unusable totals read as null, never a wrong sum', () => {
  assert.equal(addExact('', '1'), null)
  assert.equal(addExact('1.5', 'abc'), null)
  assert.equal(addExact('-2', '1'), null)
})
