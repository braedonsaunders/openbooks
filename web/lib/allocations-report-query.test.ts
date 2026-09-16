import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDriverColumns, extractDriverRows } from './allocations-report-query.ts'

test('driver columns must be plain entity columns, value numeric', () => {
  assertDriverColumns('ledger_lines', 'account_id', 'amount')
  assert.throws(() => assertDriverColumns('nope', 'account_id', 'amount'), /unknown report entity/)
  assert.throws(() => assertDriverColumns('ledger_lines', 'nope', 'amount'), /dimension column not found/)
  assert.throws(() => assertDriverColumns('ledger_lines', 'account_id', 'memo'), /must be numeric/)
})

test('extract keeps raw pairs, skips blank dimensions', () => {
  assert.deepEqual(
    extractDriverRows(
      [
        ['a1', '10.50'],
        ['', '5'],
        [null, '7'],
        ['a2', 3],
        ['a3', null],
      ],
      0,
      1,
    ),
    [
      ['a1', '10.50'],
      ['a2', '3'],
      ['a3', ''],
    ],
  )
})
