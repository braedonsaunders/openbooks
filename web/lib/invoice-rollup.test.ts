import assert from 'node:assert/strict'
import test from 'node:test'
import { sum } from '@openbooks/engine/src/money.ts'
import {
  applyRollup,
  lineMatchesGroup,
  resolveInvoicingProfile,
  rollupProblems,
  type RollupLine,
} from './invoice-rollup'

const line = (over: Partial<RollupLine> = {}): RollupLine =>
  ({ amount: '100.00', quantity: '1', description: null, ...over })

const make = (group: { label: string }, amount: string, quantity: string): RollupLine =>
  ({ amount, quantity, description: group.label })

const LABOUR_AND_EQUIPMENT = {
  mode: 'by_group' as const,
  groups: [
    { label: 'Labour', isLabor: true },
    { label: 'Equipment', isLabor: false, itemCategories: ['2'] },
  ],
}

test('lines collapse into their declared groups, in the declared order', () => {
  const { presented, collapsed } = applyRollup(
    [
      line({ amount: '500.00', isLabor: true }),
      line({ amount: '250.00', isLabor: true }),
      line({ amount: '80.00', isLabor: false, itemCategory: '2' }),
    ],
    LABOUR_AND_EQUIPMENT,
    make,
  )
  assert.equal(collapsed, true)
  // money is carried at four decimals throughout the ledger
  assert.deepEqual(presented.map((l) => [l.description, l.amount]), [
    ['Labour', '750.0000'],
    ['Equipment', '80.0000'],
  ])
})

test('a line matching no group keeps its own line rather than vanishing', () => {
  const { presented } = applyRollup(
    [line({ amount: '500.00', isLabor: true }), line({ amount: '33.00', isLabor: false, itemCategory: '9' })],
    LABOUR_AND_EQUIPMENT,
    make,
  )
  assert.equal(presented.length, 2)
  assert.equal(presented[1]!.amount, '33.00')
})

test('every source line maps to a real presented line, so nothing loses provenance', () => {
  const lines = [
    line({ amount: '500.00', isLabor: true }),
    line({ amount: '250.00', isLabor: true }),
    line({ amount: '80.00', isLabor: false, itemCategory: '2' }),
    line({ amount: '33.00', isLabor: false, itemCategory: '9' }),
  ]
  const { presented, presentedIndexOf } = applyRollup(lines, LABOUR_AND_EQUIPMENT, make)
  assert.equal(presentedIndexOf.length, lines.length)
  for (const index of presentedIndexOf) {
    assert.ok(index >= 0 && index < presented.length, `index ${index} is not a presented line`)
  }
  assert.equal(presentedIndexOf[0], presentedIndexOf[1]) // both labour rows -> one line
  assert.notEqual(presentedIndexOf[0], presentedIndexOf[2])
})

test('rolling up never changes the invoice total', () => {
  const lines = [
    line({ amount: '500.00', isLabor: true }),
    line({ amount: '0.05', isLabor: true }),
    line({ amount: '80.00', isLabor: false, itemCategory: '2' }),
    line({ amount: '33.00', isLabor: false, itemCategory: '9' }),
  ]
  const total = (xs: RollupLine[]) => sum(xs.map((x) => x.amount))
  const { presented } = applyRollup(lines, LABOUR_AND_EQUIPMENT, make)
  assert.equal(total(presented), total(lines))
})

test('no rollup, or a mode of none, leaves the lines exactly as they were', () => {
  const lines = [line({ amount: '1.00' }), line({ amount: '2.00' })]
  assert.equal(applyRollup(lines, undefined, make).presented, lines)
  assert.equal(applyRollup(lines, { mode: 'none' }, make).presented, lines)
})

interface AccountingLine extends RollupLine {
  accountId: string
  unitId: string
}
const accountingLine = (over: Partial<AccountingLine> = {}): AccountingLine =>
  ({ ...line(), accountId: 'income-a', unitId: 'hours', isLabor: true, ...over })
const makeAccountingLine = (
  group: { label: string }, amount: string, quantity: string, members: AccountingLine[],
): AccountingLine => ({ ...members[0]!, description: group.label, amount, quantity })
const accountingPartition = (member: AccountingLine) => JSON.stringify([member.accountId, member.unitId])

test('one presentation group preserves different account partitions', () => {
  const lines = [accountingLine(), accountingLine({ accountId: 'income-b', amount: '75.00' })]
  const result = applyRollup(lines, LABOUR_AND_EQUIPMENT, makeAccountingLine, accountingPartition)
  assert.deepEqual(result.presented.map((member) => [member.accountId, member.amount]), [
    ['income-a', '100.0000'], ['income-b', '75.0000'],
  ])
  assert.deepEqual(result.presentedIndexOf, [0, 1])
})

test('identical partition metadata collapses and supplies all original members to the builder', () => {
  const lines = [accountingLine(), accountingLine({ amount: '25.00', quantity: '2' })]
  const result = applyRollup(lines, LABOUR_AND_EQUIPMENT, (group, amount, quantity, members) => {
    assert.deepEqual(members, lines)
    assert.equal(members[0], lines[0])
    assert.equal(members[1], lines[1])
    return makeAccountingLine(group, amount, quantity, members)
  }, accountingPartition)
  assert.equal(result.presented.length, 1)
  assert.equal(result.presented[0]!.amount, '125.0000')
  assert.equal(result.presented[0]!.quantity, '3.0000')
  assert.deepEqual(result.presentedIndexOf, [0, 0])
})

test('interleaved groups, partitions and unmatched lines retain complete source mapping', () => {
  const equipment = { isLabor: false, itemCategory: '2', unitId: 'days' }
  const lines = [
    accountingLine({ ...equipment, accountId: 'income-b' }),
    accountingLine({ accountId: 'income-b' }),
    accountingLine({ isLabor: false, itemCategory: 'unmatched-1' }),
    accountingLine(),
    accountingLine(equipment),
    accountingLine({ accountId: 'income-b' }),
    accountingLine({ isLabor: false, itemCategory: 'unmatched-2' }),
    accountingLine({ ...equipment, accountId: 'income-b' }),
  ]
  const result = applyRollup(lines, LABOUR_AND_EQUIPMENT, makeAccountingLine, accountingPartition)
  assert.deepEqual(result.presented.slice(0, 4).map((member) => [member.description, member.accountId, member.amount]), [
    ['Labour', 'income-b', '200.0000'], ['Labour', 'income-a', '100.0000'],
    ['Equipment', 'income-b', '200.0000'], ['Equipment', 'income-a', '100.0000'],
  ])
  assert.deepEqual(result.presentedIndexOf, [2, 0, 4, 1, 3, 0, 5, 2])
  assert.equal(result.presented[4], lines[2])
  assert.equal(result.presented[5], lines[6])
  assert.equal(sum(result.presented.map((member) => member.amount)), sum(lines.map((member) => member.amount)))
})

test('quantity aggregation preserves eight decimal places and large exact quantities', () => {
  const lines = [
    line({ isLabor: true, quantity: '9007199254740993.12345678' }),
    line({ isLabor: true, quantity: '0.00000001' }),
    line({ isLabor: true, quantity: '-0.00000002' }),
  ]
  const result = applyRollup(lines, LABOUR_AND_EQUIPMENT, make)
  assert.equal(result.presented[0]!.quantity, '9007199254740993.12345677')
  assert.deepEqual(result.presentedIndexOf, [0, 0, 0])
  assert.throws(() => applyRollup([
    line({ isLabor: true, quantity: '0.000000001' }),
  ], LABOUR_AND_EQUIPMENT, make), /loses precision beyond 8 decimal places/)
})

test('a group states conditions that are ANDed', () => {
  const group = { label: 'Shop equipment', isLabor: false, itemCategories: ['2'], sourceKinds: ['sales_order'] }
  assert.equal(lineMatchesGroup(line({ isLabor: false, itemCategory: '2', sourceKind: 'sales_order' }), group), true)
  assert.equal(lineMatchesGroup(line({ isLabor: false, itemCategory: '2', sourceKind: 'vendor_bill' }), group), false)
  assert.equal(lineMatchesGroup(line({ isLabor: true, itemCategory: '2', sourceKind: 'sales_order' }), group), false)
})

test('the project overrides the customer, which overrides the project type', () => {
  const resolved = resolveInvoicingProfile(
    { lineBuilder: 'tm_actual', ticketCostScope: 'ticket_only' } as never,
    { ticketCostScope: 'ticket_or_period', surchargeRounding: 'down' } as never,
    { surchargeRounding: 'half_up' } as never,
  )
  assert.equal((resolved as never as Record<string, string>).lineBuilder, 'tm_actual')
  assert.equal((resolved as never as Record<string, string>).ticketCostScope, 'ticket_or_period')
  assert.equal((resolved as never as Record<string, string>).surchargeRounding, 'half_up')
})

test('a group with no conditions is reported rather than silently eating the invoice', () => {
  assert.deepEqual(rollupProblems({ mode: 'by_group', groups: [{ label: 'Everything' }] }),
    ['"Everything" matches every line — give it a condition'])
  assert.deepEqual(rollupProblems({ mode: 'by_group', groups: [] }),
    ['Grouped presentation needs at least one group'])
  assert.deepEqual(rollupProblems({ mode: 'none' }), [])
})
