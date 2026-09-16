import assert from 'node:assert/strict'
import test from 'node:test'
import {
  groupIdOf,
  groupIdsInOrder,
  groupMembers,
  groupTotal,
  isGroupLocked,
  moneyDiffers,
  reapportionGroupTotal,
  unsplitGroup,
} from './distribution-groups.ts'

const row = (amount: string, group?: string | null, locked = false) => ({
  amount,
  distributionGroupId: group ?? null,
  distributionLocked: locked,
})

test('blank group ids stand alone; shared ids collect in grid order', () => {
  assert.equal(groupIdOf(row('10', null)), null)
  assert.equal(groupIdOf(row('10', '')), null)
  assert.equal(groupIdOf(row('10', '  ')), null)
  assert.equal(groupIdOf(row('10', 'g1')), 'g1')

  const rows = [row('10', 'g1'), row('5'), row('7', 'g1'), row('3', 'g2')]
  assert.deepEqual(
    groupMembers(rows, 'g1').map((m) => m.index),
    [0, 2],
  )
  assert.deepEqual(groupIdsInOrder(rows), ['g1', 'g2'])
})

test('group total is the exact booked sum, blanks counting as zero', () => {
  // 100.10 - 0.10 splits across two children and a half-typed third row:
  // the header must show exactly the entered amount, never a float wobble.
  assert.equal(groupTotal([row('60.10', 'g'), row('40.00', 'g'), row('', 'g')]), '100.1000')
  assert.equal(groupTotal([row('-20', 'g'), row('120', 'g')]), '100.0000')
})

test('one locked child locks the whole group against re-explosion', () => {
  assert.equal(isGroupLocked([row('60', 'g'), row('40', 'g')]), false)
  assert.equal(isGroupLocked([row('60', 'g', true), row('40', 'g')]), true)
  assert.equal(isGroupLocked([]), false)
})

test('re-exploding the total keeps every share and never loses a cent', () => {
  // 60/40 of 100 re-exploded to 300 stays 180/120 with an exact sum.
  assert.deepEqual(reapportionGroupTotal(['60.00', '40.00'], '300'), ['180.0000', '120.0000'])
  // A repeating split absorbs the remainder deterministically: 100 across
  // three equal children is 33.3334/33.3333/33.3333 — all remainders tie,
  // so grid order wins — and the parts always sum to the entered total.
  const thirds = reapportionGroupTotal(['1', '1', '1'], '100')
  assert.equal(thirds.length, 3)
  assert.deepEqual(thirds, ['33.3334', '33.3333', '33.3333'])
  assert.equal(groupTotal(thirds.map((amount) => row(amount, 'g'))), '100.0000')
  // Sign rides along: a negative group total keeps children non-positive.
  assert.deepEqual(reapportionGroupTotal(['60', '40'], '-100'), ['-60.0000', '-40.0000'])
})

test('re-exploding a zero group puts the total on the first child', () => {
  assert.deepEqual(reapportionGroupTotal(['0', '0'], '50'), ['50.0000', '0.0000'])
  assert.deepEqual(reapportionGroupTotal([], '50'), [])
})

test('un-split collapses to the first child carrying the group total', () => {
  const rows = [row('60.10', 'g'), row('5'), row('40.00', 'g')]
  const collapsed = unsplitGroup(rows, 'g')
  assert.deepEqual(collapsed, { keepIndex: 0, total: '100.1000' })
  assert.equal(unsplitGroup(rows, 'missing'), null)
})

test('amount comparison tolerates formatting but catches real edits', () => {
  assert.equal(moneyDiffers('100.10', '100.1000'), false)
  assert.equal(moneyDiffers('100.10', '100.11'), true)
})
