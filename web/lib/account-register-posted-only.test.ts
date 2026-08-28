import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./reports/registers.ts', import.meta.url), 'utf8')
const accountRegister = source.slice(
  source.indexOf('export async function accountRegister'),
  source.indexOf('// ---------------------------------------------------------------------------\n// AR / AP Register'),
)

test('account register line and total queries use only posted ledger entries', () => {
  const postedFence = "and e.status in ('posted', 'reversed')"
  assert.equal(
    accountRegister.split(postedFence).length - 1,
    2,
    'both the paged lines and independent totals query must fence journal status',
  )
  assert.match(accountRegister, /where l\.account_id in \(select id from account_scope\)/)
})
