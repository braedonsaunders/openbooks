import assert from 'node:assert/strict'
import test from 'node:test'
import { toUnits as moneyToUnits } from '@openbooks/engine/src/money.ts'
import {
  decimalAdd,
  decimalCmp,
  decimalNeg,
  decimalPercentChange,
  decimalScale,
  decimalScaleWhole,
  decimalSum,
  fromDecimalUnits,
  marginRatioToPercent,
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

test('scaled whole-unit display rounds once from the ledger value', () => {
  // 1499.9999 is 1.49999999 thousand: printing it in thousands must read 1,
  // not 2. A two-step scale-then-format rounds 1.49999999 up to 1.5000 first
  // and the display rounding then carries it to 2.
  assert.equal(decimalScaleWhole('1499.9999', 1000), '1.0000')
  assert.equal(decimalScaleWhole('-1499.9999', 1000), '-1.0000')
  assert.equal(decimalScaleWhole('1500.0000', 1000), '2.0000')
  assert.equal(decimalScaleWhole('1499999.9999', 1000000), '1.0000')
  assert.equal(decimalScaleWhole('2500000.0000', 1000000), '3.0000')
  assert.equal(decimalScaleWhole('0.0000', 1000), '0.0000')
})

test('margin ratios scale exactly once to percent units for presentation', () => {
  // decimalRatio returns a canonical ratio (0.2500 = 25%). Display (Intl
  // percent style) and export (toFixed) must share this single scaling so
  // they cannot diverge again.
  assert.equal(marginRatioToPercent('0.2500'), '25.0000')
  assert.equal(marginRatioToPercent('0.0000'), '0.0000')
  assert.equal(marginRatioToPercent('-0.2500'), '-25.0000')
  assert.equal(marginRatioToPercent('1.0000'), '100.0000')
})

test('decimal parsing agrees with the shared money primitive on every exponent case', () => {
  // statement-format used to parse scientific exponents unbounded while
  // engine money.ts bounds them (±10000) against input-amplified growth.
  // money.ts is authoritative: the two must agree, value or throw, on each.
  const throwing = ['1e10001', '1e-10001', '1e1000000000', '1E-1000000000', '1e99999999999999999', '1.23456', 'abc']
  for (const input of throwing) {
    assert.throws(() => toDecimalUnits(input), Error, `expected throw for ${input}`)
    assert.throws(() => moneyToUnits(input), Error, `money must also throw for ${input}`)
  }
  const values: Array<[string | number, bigint]> = [
    ['12.3456', 123456n],
    ['-0.0001', -1n],
    ['.5', 5000n],
    [123, 1230000n],
    ['1.2355303E7', 123553030000n],
    ['1e4', 100000000n],
    ['1e+5', 1000000000n],
    ['1.5e1', 150000n],
    ['1e10000', 10n ** 10004n],
  ]
  for (const [input, expected] of values) {
    assert.equal(toDecimalUnits(input), expected, `value mismatch for ${input}`)
    assert.equal(moneyToUnits(input), expected, `money mismatch for ${input}`)
  }
})
