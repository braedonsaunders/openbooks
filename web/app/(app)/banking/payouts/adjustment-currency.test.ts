import assert from 'node:assert/strict'
import test from 'node:test'
import { adjustmentCurrency } from './adjustment-currency.ts'

test('the line currency wins over the batch currency', () => {
  assert.equal(adjustmentCurrency('EUR', 'USD'), 'EUR')
})

test('the batch currency backs up a line without one', () => {
  assert.equal(adjustmentCurrency(null, 'USD'), 'USD')
  assert.equal(adjustmentCurrency(undefined, 'USD'), 'USD')
})

test('no currency anywhere resolves to no currency, never a guessed one', () => {
  // The confirmation must refuse here: pricing the line in a fallback
  // currency would ask the operator to confirm a figure in the wrong money.
  assert.equal(adjustmentCurrency(null, null), null)
  assert.equal(adjustmentCurrency(undefined, undefined), null)
  assert.equal(adjustmentCurrency(null, undefined), null)
})
