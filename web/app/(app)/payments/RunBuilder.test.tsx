import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { sum } from '@openbooks/engine/src/money.ts'

const source = readFileSync(new URL('./RunBuilder.tsx', import.meta.url), 'utf8')

test('payment-run selected totals preserve exact per-currency ledger decimals', () => {
  assert.doesNotMatch(
    source,
    /\+ Number\(bill\.open\)/,
    'selected payment totals must not cross the JavaScript floating-point boundary',
  )
  assert.match(source, /sum\(amounts\)/)
  assert.equal(
    sum(['9007199254740992.0000', '1.0001']),
    '9007199254740993.0001',
  )
})
