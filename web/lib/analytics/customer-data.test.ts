import assert from 'node:assert/strict'
import test from 'node:test'
import { exactProfit } from './customer-profitability-money'

test('customer profit keeps a cent beyond the safe integer range', () => {
  assert.equal(exactProfit('9007199254740993.01', '9007199254740993.00'), '0.0100')
})
