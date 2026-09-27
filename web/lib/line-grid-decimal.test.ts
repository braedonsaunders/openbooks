import assert from 'node:assert/strict'
import test from 'node:test'
import {
  displayLineDecimal,
  invalidLineDecimal,
  normalizeLineDecimal,
} from './line-grid-decimal.ts'

test('line decimal display removes storage-scale zeroes without rounding', () => {
  assert.equal(displayLineDecimal('1.00000000'), '1')
  assert.equal(displayLineDecimal('35.63000000'), '35.63')
  assert.equal(displayLineDecimal('0.12345678'), '0.12345678')
  assert.equal(displayLineDecimal('9007199254740993.12345678'), '9007199254740993.12345678')
  assert.equal(displayLineDecimal('-0.00000000'), '0')
})

test('line decimal normalization preserves exact meaningful precision', () => {
  assert.equal(normalizeLineDecimal('00012.34000000'), '12.34')
  assert.equal(normalizeLineDecimal('0.00000001'), '0.00000001')
  assert.equal(normalizeLineDecimal(''), '')
  assert.equal(normalizeLineDecimal('1.000000001'), null)
  assert.equal(normalizeLineDecimal('1e3'), null)
})

test('line decimal validation rejects precision loss and malformed input', () => {
  assert.equal(invalidLineDecimal('43.56678400'), false)
  assert.equal(invalidLineDecimal(''), false)
  assert.equal(invalidLineDecimal('43.566784001'), true)
  assert.equal(invalidLineDecimal('not-a-number'), true)
})
