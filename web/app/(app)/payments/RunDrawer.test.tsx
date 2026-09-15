import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { sum } from '@openbooks/engine/src/money.ts'

const source = readFileSync(new URL('./RunDrawer.tsx', import.meta.url), 'utf8')

test('payment-run confirmation totals preserve exact ledger decimals', () => {
  assert.doesNotMatch(
    source,
    /live\.reduce\(\(acc, i\) => acc \+ Number\(i\.amount\), 0\)/,
    'run totals must not cross the JavaScript floating-point boundary',
  )
  assert.match(source, /const total = sum\(live\.map\(\(i\) => String\(i\.amount\)\)\)/)
  assert.equal(
    sum(['9007199254740992.0000', '1.0001']),
    '9007199254740993.0001',
  )
})
