import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalDecimal, compareDecimal, fixedDecimal, isPositiveDecimal, isZeroDecimal } from './exact-decimal.ts'

test('request decimal handling never crosses the floating-point boundary', () => {
  assert.equal(canonicalDecimal('9007199254740993.1234'), '9007199254740993.1234')
  assert.equal(canonicalDecimal('00012.3400'), '12.34')
  assert.equal(canonicalDecimal('-0.0000'), '0')
  assert.equal(canonicalDecimal('1.00001'), null)
  assert.equal(canonicalDecimal('1e3'), null)
  assert.equal(compareDecimal('9007199254740993.0001', '9007199254740993'), 1)
  assert.equal(compareDecimal('-0.0001', '0'), -1)
  assert.equal(isPositiveDecimal('0.0001'), true)
  assert.equal(isZeroDecimal('0.0000'), true)
  assert.equal(fixedDecimal('12.34', 4), '12.3400')
})
