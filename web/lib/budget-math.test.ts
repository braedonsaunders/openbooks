import assert from 'node:assert/strict'
import test from 'node:test'
import { budgetFromUnits, budgetToUnits, spreadBudgetTotal, upliftBudgetAmount } from './budget-math.ts'

test('budget decimals retain four-place exactness', () => {
  assert.equal(budgetToUnits('123.4567'), 1_234_567n)
  assert.equal(budgetFromUnits(-1_234_567n), '-123.4567')
  assert.throws(() => budgetToUnits('1.00001'))
})

test('annual totals spread without losing a unit', () => {
  const values = spreadBudgetTotal('100.0000', 12)
  assert.equal(values.reduce((sum, value) => sum + budgetToUnits(value), 0n), budgetToUnits('100'))
  assert.deepEqual(spreadBudgetTotal('-0.0002', 3), ['-0.0001', '-0.0001', '0.0000'])
})

test('percentage uplift rounds at four decimal places', () => {
  assert.equal(upliftBudgetAmount('100.0000', '2.5'), '102.5000')
  assert.equal(upliftBudgetAmount('-1.0000', '10'), '-1.1000')
})
