import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearedDistributionFields,
  computeDocumentDrawerTotals,
  distributionFieldsOf,
  isPricedDrawerLine,
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
