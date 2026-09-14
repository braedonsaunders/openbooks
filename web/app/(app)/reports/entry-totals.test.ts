import assert from 'node:assert/strict'
import test from 'node:test'
import { entryTotals } from './entry-totals'

test('visible subsidiary legs never invent a matching opposite total', () => {
  assert.deepEqual(entryTotals([{ amount: '100.0000' }, { amount: '-30.0000' }]), { debit: '100.0000', credit: '30.0000' })
  assert.deepEqual(entryTotals([{ amount: '-100.0000' }]), { debit: '0.0000', credit: '100.0000' })
})
test('balanced and fractional visible entries conserve both sides exactly', () => {
  assert.deepEqual(entryTotals([{ amount: '0.0101' }, { amount: '0.0202' }, { amount: '-0.0303' }]), { debit: '0.0303', credit: '0.0303' })
  assert.deepEqual(entryTotals([]), { debit: '0.0000', credit: '0.0000' })
})
