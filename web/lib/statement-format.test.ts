import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decimalAdd,
  decimalCmp,
  decimalNeg,
  decimalPercentChange,
  decimalScale,
  decimalSum,
  fromDecimalUnits,
  toDecimalUnits,
} from './statement-format.ts'

test('exact decimal helpers do not inherit binary floating-point drift', () => {
  assert.equal(decimalAdd('0.1000', '0.2000'), '0.3000')
  assert.equal(decimalSum(['0.1000', '0.2000', '-0.3000']), '0.0000')
  assert.equal(decimalSum(['999999999999999.9999', '0.0001']), '1000000000000000.0000')
  assert.equal(decimalNeg('-123.4567'), '123.4567')
})

test('exact decimal helpers preserve four-decimal ledger precision', () => {
  const units = toDecimalUnits('-9876543210.0123')
  assert.equal(fromDecimalUnits(units), '-9876543210.0123')
  assert.equal(decimalCmp('1.0000', '0.9999'), 1)
  assert.throws(() => toDecimalUnits('1.00001'), /loses precision/)
})

test('exact scaling and variance calculations round deterministically', () => {
  assert.equal(decimalScale('1499.9999', 1000), '1.5000')
  assert.equal(decimalScale('-1499.9999', 1000), '-1.5000')
  assert.equal(decimalPercentChange('110.0000', '100.0000'), '10.0000')
  assert.equal(decimalPercentChange('90.0000', '100.0000'), '-10.0000')
  assert.equal(decimalPercentChange('1.0000', '0.0000'), null)
})
