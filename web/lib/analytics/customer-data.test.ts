import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./customer-data.ts', import.meta.url), 'utf8')
const paymentCte = source.slice(source.indexOf('// Payment behaviour'), source.indexOf('// Growth trends'))

test('customer payment rollup compares invoice totals with transaction-currency applications', () => {
  assert.match(paymentCte, /coalesce\(sum\(ap\.target_transaction_amount\), 0\) as applied/)
  assert.doesNotMatch(paymentCte, /coalesce\(sum\(ap\.amount\), 0\) as applied/)
})

test('customer payment rollup excludes unapplied application reversals', () => {
  assert.match(paymentCte, /ap\.unapplied_at is null/)
})
