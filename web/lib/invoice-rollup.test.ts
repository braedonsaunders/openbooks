import assert from 'node:assert/strict'
import test from 'node:test'
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
  const total = (xs: RollupLine[]) => xs.reduce((t, x) => t + Number(x.amount), 0).toFixed(2)
  const { presented } = applyRollup(lines, LABOUR_AND_EQUIPMENT, make)
  assert.equal(total(presented), total(lines))
})

test('no rollup, or a mode of none, leaves the lines exactly as they were', () => {
  const lines = [line({ amount: '1.00' }), line({ amount: '2.00' })]
  assert.equal(applyRollup(lines, undefined, make).presented, lines)
  assert.equal(applyRollup(lines, { mode: 'none' }, make).presented, lines)
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
