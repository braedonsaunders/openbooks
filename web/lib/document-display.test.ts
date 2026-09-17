import assert from 'node:assert/strict'
import test from 'node:test'
import { displayDocumentNumber, isSourceHandle } from './document-display'

test('sync source handles are recognized', () => {
  assert.equal(isSourceHandle('salesInvoice:cf83a37e-8376-f111-a5be-7ced8d265cbd'), true)
  assert.equal(isSourceHandle('salesInvoicePayment:cf83a37e-8376-f111-a5be-7ced8d265cbd'), true)
  assert.equal(isSourceHandle('Payment:3f2504e0-4f89-11d3-9a0c-0305e82c3301'), true)
})

test('ordinary numbers are not handles', () => {
  for (const plain of ['INV-00046', 'PS-INV103296', 'PAY-PS-INV', 'SO-00002', '', 'SO:123', 'a:b:c']) {
    assert.equal(isSourceHandle(plain), false, JSON.stringify(plain))
  }
  assert.equal(isSourceHandle(null), false)
  assert.equal(isSourceHandle(undefined), false)
})

test('display falls back to the reference on handles, keeps numbers', () => {
  assert.equal(displayDocumentNumber('salesInvoice:cf83a37e-8376-f111-a5be-7ced8d265cbd', 'PS-INV103296'), 'PS-INV103296')
  assert.equal(displayDocumentNumber('salesInvoicePayment:cf83a37e-8376-f111-a5be-7ced8d265cbd', 'PAY-PS-INV'), 'PAY-PS-INV')
  assert.equal(displayDocumentNumber('INV-00046', 'PO-77'), 'INV-00046')
  // No reference to fall back to: the stored value still renders.
  assert.equal(displayDocumentNumber('salesInvoice:cf83a37e-8376-f111-a5be-7ced8d265cbd', ''), 'salesInvoice:cf83a37e-8376-f111-a5be-7ced8d265cbd')
  assert.equal(displayDocumentNumber(null, 'PS-INV103296'), '')
})
