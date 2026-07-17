import assert from 'node:assert/strict'
import test from 'node:test'
import { remainingOrderLine } from './order-cycle-math.ts'

test('remaining order conversion uses exact four-decimal arithmetic', () => {
  assert.deepEqual(remainingOrderLine({ quantity: '3.0000', quantityBilled: '1.0000', unitPrice: '0.3333', taxAmount: '0.1300' }), {
    quantity: '2.0000', amount: '0.6666', taxAmount: '0.0867',
  })
  assert.deepEqual(remainingOrderLine({ quantity: '1.0000', quantityBilled: '0.3333', unitPrice: '12.3456', taxAmount: '1.6049' }), {
    quantity: '0.6667', amount: '8.2308', taxAmount: '1.0700',
  })
})

test('fully billed lines are omitted and zero source quantity does not divide', () => {
  assert.equal(remainingOrderLine({ quantity: '1', quantityBilled: '1', unitPrice: '10', taxAmount: '1.3' }), null)
  assert.equal(remainingOrderLine({ quantity: '0', quantityBilled: '0', unitPrice: '10', taxAmount: '0' }), null)
})
