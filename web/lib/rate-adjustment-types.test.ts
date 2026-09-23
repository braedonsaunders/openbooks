import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADJUSTMENT_CALCULATIONS,
  ADJUSTMENT_TARGET_TYPES,
} from './rate-adjustment-types'
import {
  lineMatchesAdjustment,
  priceAdjustments,
  type AdjustableLine,
  type AdjustmentTarget,
  type ResolvedAdjustment,
} from './rate-adjustment-pricing'

// The save route, the card UI, and the pricing engine share ONE definition
// of the accepted target types and calculation types. This test derives both
// directions of that contract: every accepted target type matches something
// and rejects something, and every accepted calculation has a pricing case.
// A type added to the shared list without a case fails here, not on an
// invoice.

const adjustment = (over: Partial<ResolvedAdjustment> = {}): ResolvedAdjustment => ({
  id: 'a1', code: 'fuel', name: 'Fuel Surcharge', category: 'surcharge',
  calculation: 'percent', value: '10', presentation: 'separate', threshold: null,
  itemId: null, appliesRegular: true, appliesOvertime: true, appliesDoubleTime: true,
  sortOrder: 0, targets: [], ...over,
})

const target = (targetType: string, id: string | null, text: string | null): AdjustmentTarget => ({
  targetType, targetValueId: id, targetValueText: text,
})

// Per target type: the target plus a line it must measure and one it must not.
const TARGET_CASES: Record<string, { target: AdjustmentTarget; hit: AdjustableLine; miss: AdjustableLine }> = {
  labor: {
    target: target('labor', null, 'labor'),
    hit: { amount: '1', isLabor: true },
    miss: { amount: '1', isLabor: false },
  },
  material: {
    target: target('material', null, 'material'),
    hit: { amount: '1', isLabor: false },
    miss: { amount: '1', isLabor: true },
  },
  item: {
    target: target('item', 'item-1', null),
    hit: { amount: '1', itemId: 'item-1' },
    miss: { amount: '1', itemId: 'item-2' },
  },
  item_kind: {
    target: target('item_kind', null, 'service'),
    hit: { amount: '1', itemKind: 'service' },
    miss: { amount: '1', itemKind: 'inventory' },
  },
  item_category: {
    target: target('item_category', null, 'Consulting'),
    hit: { amount: '1', itemCategory: 'Consulting' },
    miss: { amount: '1', itemCategory: 'Travel' },
  },
  department: {
    target: target('department', 'dept-1', null),
    hit: { amount: '1', departmentId: 'dept-1' },
    miss: { amount: '1', departmentId: 'dept-2' },
  },
  subsidiary: {
    target: target('subsidiary', 'sub-1', null),
    hit: { amount: '1', subsidiaryId: 'sub-1' },
    miss: { amount: '1', subsidiaryId: 'sub-2' },
  },
  location: {
    target: target('location', 'loc-1', null),
    hit: { amount: '1', locationId: 'loc-1' },
    miss: { amount: '1', locationId: 'loc-2' },
  },
  class: {
    target: target('class', 'class-1', null),
    hit: { amount: '1', classId: 'class-1' },
    miss: { amount: '1', classId: 'class-2' },
  },
  trade: {
    target: target('trade', 'trade-1', null),
    hit: { amount: '1', tradeIds: ['trade-1'] },
    miss: { amount: '1', tradeIds: ['trade-2'] },
  },
  job_title: {
    target: target('job_title', null, 'Foreman'),
    hit: { amount: '1', jobTitles: ['Foreman'] },
    miss: { amount: '1', jobTitles: ['Apprentice'] },
  },
  project: {
    target: target('project', 'proj-1', null),
    hit: { amount: '1', projectId: 'proj-1' },
    miss: { amount: '1', projectId: 'proj-2' },
  },
  customer: {
    target: target('customer', 'cust-1', null),
    hit: { amount: '1', customerId: 'cust-1' },
    miss: { amount: '1', customerId: 'cust-2' },
  },
}

test('every accepted target type measures its own lines and nothing else', () => {
  for (const targetType of ADJUSTMENT_TARGET_TYPES) {
    const cases = TARGET_CASES[targetType]
    assert.ok(cases, `accepted target type "${targetType}" has no matcher case or test coverage`)
    const a = adjustment({ targets: [cases.target] })
    assert.equal(lineMatchesAdjustment(cases.hit, a), true, `${targetType} must match`)
    assert.equal(lineMatchesAdjustment(cases.miss, a), false, `${targetType} must not match`)
  }
})

test('every accepted calculation has a pricing case', () => {
  const labor = (amount: string, over: Partial<AdjustableLine> = {}): AdjustableLine =>
    ({ amount, isLabor: true, ...over })
  for (const calculation of ADJUSTMENT_CALCULATIONS) {
    switch (calculation) {
      case 'percent': {
        const [charge] = priceAdjustments([labor('1000.00')], [adjustment({ calculation, value: '10' })])
        assert.equal(charge?.amount, '100.0000')
        break
      }
      case 'fixed': {
        const [charge] = priceAdjustments([labor('1000.00')], [adjustment({ calculation, value: '25' })])
        assert.equal(charge?.amount, '25')
        break
      }
      case 'per_hour': {
        const [charge] = priceAdjustments(
          [labor('1000.00', { quantity: '10' })],
          [adjustment({ calculation, value: '5.00' })],
        )
        assert.equal(charge?.quantityBasis, '10')
        assert.equal(charge?.amount, '50.0000')
        break
      }
      case 'per_day': {
        const [charge] = priceAdjustments(
          [
            labor('800.00', { quantity: '8', workedOn: '2026-07-14' }),
            labor('800.00', { quantity: '8', workedOn: '2026-07-15' }),
          ],
          [adjustment({ calculation, value: '50.00' })],
        )
        assert.equal(charge?.quantityBasis, '2')
        assert.equal(charge?.amount, '100.0000')
        break
      }
      case 'text': {
        // Informational text is defined to never carry an amount.
        assert.equal(priceAdjustments([labor('100.00')], [adjustment({ calculation, value: null })]).length, 0)
        break
      }
      default:
        assert.fail(`accepted calculation "${calculation}" has no pricing case`)
    }
  }
})
