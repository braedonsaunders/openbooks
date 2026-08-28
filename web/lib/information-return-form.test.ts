import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatBoxAmount,
  renderInformationReturnBody,
  type RecipientFormData,
} from './information-return-form.ts'

test('recipient boxes round exact decimals without a JavaScript Number conversion', () => {
  // Number(...).toLocaleString() renders this as .10; the filed decimal rounds to .13.
  assert.equal(formatBoxAmount('999999999999999.1250'), '999,999,999,999,999.13')
})

test('recipient body applies exact adjustments and keeps ordinary box formatting', () => {
  const data: RecipientFormData = {
    formType: '1099-NEC',
    taxYear: 2026,
    payerName: 'Payer Co.',
    recipientName: 'Recipient Co.',
    computedAmounts: { nec1: '999999999999998.1250' },
    adjustments: { nec1: '1.0000' },
    corrected: false,
    void: false,
    currency: 'USD',
  }

  const body = renderInformationReturnBody(data)
  assert.match(body, /USD 999,999,999,999,999\.13/)
  assert.equal(formatBoxAmount('12.5'), '12.50')
  assert.equal(formatBoxAmount('0.0000'), '')
})
