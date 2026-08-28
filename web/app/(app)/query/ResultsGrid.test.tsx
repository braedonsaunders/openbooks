import assert from 'node:assert/strict'
import test from 'node:test'
import { compareNumericValues } from './ResultsGrid.tsx'

test('sorts exact SQL decimals beyond the JavaScript safe-integer range', () => {
  const rows = [
    { id: 'larger', amount: '9007199254740993.0000' },
    { id: 'smaller', amount: '9007199254740992.0000' },
  ]

  rows.sort((left, right) => compareNumericValues(left.amount, right.amount))

  assert.deepEqual(rows.map((row) => row.id), ['smaller', 'larger'])
})

test('sorts ordinary numeric values and keeps equal decimals equivalent', () => {
  assert.equal(compareNumericValues('1.20', '1.2'), 0)
  assert.equal(compareNumericValues('-2.5', '10'), -1)
  assert.equal(compareNumericValues('1,000.00', '999.99'), 1)
})
