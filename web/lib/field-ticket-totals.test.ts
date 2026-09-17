import assert from 'node:assert/strict'
import test from 'node:test'
import { showsUnpricedHoursNotice, unpricedLaborHours } from './field-ticket-totals'

/**
 * F-t03-005: crew hours with no bill rate price at $0 and must surface as
 * unpriced next to the labor total — never read as free work. The finding's
 * shape is an approved ticket whose 188.5 crew-hours carry NULL bill rates
 * (no labor item / no rate-book match), so the footer names them.
 */
test('null bill rates total as unpriced hours, priced rows never leak in', () => {
  assert.equal(
    unpricedLaborHours([
      { bill_rate: null, hours: '100' },
      { bill_rate: null, hours: '88.5' },
      { bill_rate: '95', hours: '40' },
      { bill_rate: '0', hours: '8' },
    ]),
    '188.5000',
  )
})

test('fully priced entries surface nothing', () => {
  assert.equal(unpricedLaborHours([{ bill_rate: '95', hours: '40' }]), '0.0000')
  assert.equal(unpricedLaborHours([]), '0.0000')
})

test('the footer notice shows exactly when unpriced hours are positive', () => {
  assert.equal(showsUnpricedHoursNotice('188.5000'), true)
  assert.equal(showsUnpricedHoursNotice('0.0000'), false)
  assert.equal(showsUnpricedHoursNotice(null), false)
})
