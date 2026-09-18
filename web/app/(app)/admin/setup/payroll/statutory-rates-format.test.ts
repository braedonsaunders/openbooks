import assert from 'node:assert/strict'
import test from 'node:test'
import { formatRateFieldValue } from './statutory-rates-format.ts'

// F-t08-008: the rates table rendered the raw decimal ("Effective rate
// 0.0060") instead of a human percent. Decimal-rate fields render as
// percents; percent and amount fields render as entered.
test('decimal rates render as percents', () => {
  assert.equal(formatRateFieldValue({ kind: 'rate', decimals: 4 }, '0.0060'), '0.60%')
  assert.equal(formatRateFieldValue({ kind: 'rate', decimals: 6 }, '0.0198'), '1.98%')
})

test('percents and amounts render as entered', () => {
  assert.equal(formatRateFieldValue({ kind: 'percent', decimals: 2 }, '2.7'), '2.7%')
  assert.equal(formatRateFieldValue({ kind: 'amount', decimals: 2 }, '7000'), '7000')
})

test('unparseable rates fall back to the raw value', () => {
  assert.equal(formatRateFieldValue({ kind: 'rate', decimals: 4 }, 'n/a'), 'n/a')
})

test('flags render as Yes or No, unknown values as entered', () => {
  assert.equal(formatRateFieldValue({ kind: 'flag', decimals: 0 }, 'true'), 'Yes')
  assert.equal(formatRateFieldValue({ kind: 'flag', decimals: 0 }, 'false'), 'No')
  assert.equal(formatRateFieldValue({ kind: 'flag', decimals: 0 }, 'yes'), 'yes')
})
