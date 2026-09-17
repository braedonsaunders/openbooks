import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyQtyPriceToRows,
  clearedDistributionFields,
  computeDocumentDrawerTotals,
  distributionFieldsOf,
  isPricedDrawerLine,
  lineAmountFromQtyPrice,
} from './document-drawer'

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

test('distribution columns map tolerantly: a line without them is simply ungrouped', () => {
  assert.deepEqual(distributionFieldsOf({}), {
    distributionGroupId: '',
    distributionRuleId: '',
    distributionRuleName: '',
    distributionVersionId: '',
    distributionLocked: false,
    distributionKey: '',
  })
  assert.deepEqual(
    distributionFieldsOf({
      distribution_group_id: 'g1',
      distribution_rule_id: 'r1',
      distribution_rule_name: 'Overhead',
      distribution_version_id: 'v1',
      distribution_locked: true,
    }),
    {
      distributionGroupId: 'g1',
      distributionRuleId: 'r1',
      distributionRuleName: 'Overhead',
      distributionVersionId: 'v1',
      distributionLocked: true,
      distributionKey: '',
    },
  )
  // Only an explicit true locks: absent (or any other shape) stays unlocked
  // so a partial read can never freeze a group the operator did not lock.
  assert.equal(distributionFieldsOf({ distribution_locked: 1 }).distributionLocked, false)
  assert.deepEqual(clearedDistributionFields(), distributionFieldsOf({}))
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

// F-t02-004: Quantity × Unit price drives the line Amount. Exact decimal
// math, ledger scale, no Number hop.
test('line amount derives exactly from quantity times unit price', () => {
  assert.equal(lineAmountFromQtyPrice('1', '1000'), '1000.0000')
  assert.equal(lineAmountFromQtyPrice('3', '1000'), '3000.0000')
  assert.equal(lineAmountFromQtyPrice('1.5', '19.99'), '29.9850')
  assert.equal(lineAmountFromQtyPrice('-2', '100'), '-200.0000')
  assert.equal(lineAmountFromQtyPrice('3', '10.333'), '30.9990')
})

test('line amount derivation refuses to guess: blank or junk keeps the manual amount', () => {
  assert.equal(lineAmountFromQtyPrice('', '1000'), null)
  assert.equal(lineAmountFromQtyPrice('3', ''), null)
  assert.equal(lineAmountFromQtyPrice('', ''), null)
  assert.equal(lineAmountFromQtyPrice('abc', '1000'), null)
  assert.equal(lineAmountFromQtyPrice('3', '1.23456789012'), null)
})

const qtyRow = (quantity: string, unitPrice: string, amount: string) => ({ quantity, unitPrice, amount })

test('a fresh qty+price prices the line: the F-t02-004 invoice flow', () => {
  const prev = [qtyRow('', '', '')]
  const next = [qtyRow('1', '1000', '')]
  assert.deepEqual(applyQtyPriceToRows(prev, next), [qtyRow('1', '1000', '1000.0000')])
})

test('editing quantity on a derived line re-derives the amount', () => {
  const prev = [qtyRow('1', '1000', '1000.0000')]
  const next = [qtyRow('3', '1000', '1000.0000')]
  assert.deepEqual(applyQtyPriceToRows(prev, next), [qtyRow('3', '1000', '3000.0000')])
})

test('a hand-typed amount that diverges from qty x price is never overwritten', () => {
  // Discount / reapportioned / tax-adjusted lines keep their manual figure
  // even when the operator edits quantity afterwards.
  const prev = [qtyRow('1', '1000', '850.0000')]
  const next = [qtyRow('3', '1000', '850.0000')]
  assert.deepEqual(applyQtyPriceToRows(prev, next), [qtyRow('3', '1000', '850.0000')])
  // …and an unrelated edit leaves derived and manual rows alike untouched.
  const same = [qtyRow('3', '1000', '3000.0000'), qtyRow('1', '100', '90.0000')]
  assert.deepEqual(applyQtyPriceToRows(same, same.map((r) => ({ ...r }))), same)
})
