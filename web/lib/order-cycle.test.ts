import assert from 'node:assert/strict'
import test from 'node:test'
import {
  billableRemainderQuantityUnits,
  fromQuantityUnits,
  remainingOrderLine,
  toQuantityUnits,
} from './order-cycle-math.ts'

test('order progress preserves eight-decimal quantities', () => {
  const remainder = remainingOrderLine({
    quantity: '1.00000001',
    quantityBilled: '0.00000000',
    unitPrice: '10.00000000',
    taxAmount: '1.5000',
  })

  assert.deepEqual(remainder, {
    quantity: '1.00000001',
    amount: '10.0000',
    taxAmount: '1.5000',
  })
})

test('billing headroom keeps received eight-decimal progress exact', () => {
  const units = billableRemainderQuantityUnits({
    orderedQuantity: '1.00000001',
    billedQuantity: '0.00000000',
    fulfilledQuantity: '1.00000001',
    requiresReceipt: true,
  })

  assert.equal(fromQuantityUnits(units), '1.00000001')
  assert.equal(toQuantityUnits('1.00000001'), units)
})
