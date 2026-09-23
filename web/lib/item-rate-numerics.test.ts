import assert from 'node:assert/strict'
import test from 'node:test'
import { ITEM_RATE_DECIMAL_SCALE, ITEM_RATE_WHOLE_DIGITS, parseItemRateDecimal } from './item-rate-numerics.ts'

test('item-rate numerics pin the numeric(19,4) column shape', () => {
  assert.equal(ITEM_RATE_DECIMAL_SCALE, 4)
  assert.equal(ITEM_RATE_WHOLE_DIGITS, 15)
})

test('valid four-decimal values parse', () => {
  assert.deepEqual(parseItemRateDecimal('1'), { value: '1' })
  assert.deepEqual(parseItemRateDecimal('1.2345'), { value: '1.2345' })
  assert.deepEqual(parseItemRateDecimal('0.0001'), { value: '0.0001' })
})

test('excess precision is distinguished from garbage', () => {
  assert.deepEqual(parseItemRateDecimal('1.00005'), { error: 'too-many-decimals' })
  assert.deepEqual(parseItemRateDecimal('1.23456'), { error: 'too-many-decimals' })
  assert.deepEqual(parseItemRateDecimal('abc'), { error: 'not-a-number' })
  assert.deepEqual(parseItemRateDecimal(''), { error: 'not-a-number' })
})

test('over-wide whole digits are refused', () => {
  assert.deepEqual(parseItemRateDecimal('9999999999999999.0000'), { error: 'too-wide' })
  assert.deepEqual(parseItemRateDecimal('999999999999999.9999'), { value: '999999999999999.9999' })
})
