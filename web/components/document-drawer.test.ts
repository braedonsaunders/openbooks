import assert from 'node:assert/strict'
import test from 'node:test'
import { computeDocumentDrawerTotals, isPricedDrawerLine } from './document-drawer'

const row = (accountId: string, amount: string) => ({
  accountId,
  amount,
  taxInputAmount: '',
  taxProfileId: '',
  taxOverridden: false,
  taxAmount: '',
})

test('priced-line detection keeps signed amounts and drops only blank placeholder rows', () => {
  assert.equal(isPricedDrawerLine(row('a', '100')), true)
  // A restocking fee netted inside a credit memo, a discount line inside an
  // invoice: the server passes signed lines to computeBillTotals untouched,
  // so the drawer must send them instead of silently dropping the row.
  assert.equal(isPricedDrawerLine(row('a', '-20')), true)
  // A zero memo line books as zero — it must ride along, not vanish.
  assert.equal(isPricedDrawerLine(row('a', '0')), true)
  assert.equal(isPricedDrawerLine(row('a', '')), false)
  assert.equal(isPricedDrawerLine(row('a', '   ')), false)
  assert.equal(isPricedDrawerLine(row('', '100')), false)
})

test('the reviewed footer total is the booked total: save keeps every row the footer prices', () => {
  const rows = [
    row('a', '100'),
    row('a', '-20'),
    row('a', '0'),
    row('a', ''),
    row('', '50'),
  ]
  const reviewed = computeDocumentDrawerTotals(rows, new Map(), false)
  assert.equal(reviewed.total, '80.0000')
  // Totals over exactly the rows the save payload keeps must match the
  // reviewed footer — otherwise the drawer books something other than what
  // the operator reviewed.
  const booked = computeDocumentDrawerTotals(rows.filter(isPricedDrawerLine), new Map(), false)
  assert.equal(booked.total, reviewed.total)
})
