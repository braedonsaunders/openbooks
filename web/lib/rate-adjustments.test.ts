import assert from 'node:assert/strict'
import test from 'node:test'
import {
  lineMatchesAdjustment,
  mergeCharges,
  priceAdjustments,
  type AdjustableLine,
  type ResolvedAdjustment,
} from './rate-adjustment-pricing'

const adjustment = (over: Partial<ResolvedAdjustment> = {}): ResolvedAdjustment => ({
  id: 'a1', code: 'fuel', name: 'Fuel Surcharge', category: 'surcharge',
  calculation: 'percent', value: '3.75', presentation: 'separate', threshold: null,
  itemId: null, appliesRegular: true, appliesOvertime: true, appliesDoubleTime: true,
  sortOrder: 0, targets: [], ...over,
})
const labor = (amount: string, over: Partial<AdjustableLine> = {}): AdjustableLine =>
  ({ amount, isLabor: true, ...over })

test('a percent value is a percentage, not a fraction', () => {
  const [charge] = priceAdjustments([labor('1000.00')], [adjustment()])
  assert.equal(charge!.amount, '37.5000')
})

test('an untargeted adjustment measures labor only, never materials', () => {
  const charges = priceAdjustments(
    [labor('1000.00'), { amount: '5000.00', isLabor: false }],
    [adjustment()],
  )
  assert.equal(charges[0]!.basis, '1000.0000')
})

test('a material target reaches cost lines', () => {
  const a = adjustment({ targets: [{ targetType: 'material', targetValueId: null, targetValueText: null }] })
  const charges = priceAdjustments([labor('1000.00'), { amount: '400.00', isLabor: false }], [a])
  assert.equal(charges[0]!.basis, '400.0000')
})

test('included and informational adjustments add no line', () => {
  assert.equal(priceAdjustments([labor('1000.00')], [adjustment({ presentation: 'included' })]).length, 0)
  assert.equal(priceAdjustments([labor('1000.00')], [adjustment({ presentation: 'informational' })]).length, 0)
})

test('a threshold is a floor on the basis, so below it nothing triggers', () => {
  const a = adjustment({ threshold: '2000' })
  assert.equal(priceAdjustments([labor('1000.00')], [a]).length, 0)
  assert.equal(priceAdjustments([labor('3000.00')], [a]).length, 1)
})

test('a threshold compares exact decimals, never floats', () => {
  // At numeric(19,4) magnitude Number() collapses 4dp neighbors:
  // Number('900719925474099.0000') === Number('900719925474099.0001'), so a
  // float comparison charges a basis one tenth-thousandth below the floor.
  const below = adjustment({ threshold: '900719925474099.0001' })
  assert.equal(priceAdjustments([labor('900719925474099.0000')], [below]).length, 0)
  const above = adjustment({ threshold: '900719925474099.0000' })
  const [charge] = priceAdjustments([labor('900719925474099.0001')], [above])
  assert.equal(charge!.basis, '900719925474099.0001')
})

test('overtime can be excluded from a surcharge', () => {
  const a = adjustment({ appliesOvertime: false })
  assert.equal(lineMatchesAdjustment(labor('100', { timeKind: 'overtime' }), a), false)
  assert.equal(lineMatchesAdjustment(labor('100', { timeKind: 'regular' }), a), true)
})

test('merging prices once off the combined basis rather than summing rounded parts', () => {
  // 33.33 and 33.33 each round to 1.25; the combined 66.66 is 2.50, not 2.50 by
  // luck — use a basis where per-part rounding provably drifts.
  const a = adjustment({ value: '10' })
  const merged = mergeCharges([
    { adjustment: a, basis: '0.05', amount: '0.01' },
    { adjustment: a, basis: '0.05', amount: '0.01' },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.basis, '0.1000')
  assert.equal(merged[0]!.amount, '0.0100') // 10% of 0.10, not 0.01 + 0.01
})

test('a fixed charge is billed once even when several departments resolve it', () => {
  const a = adjustment({ calculation: 'fixed', value: '250.00' })
  const merged = mergeCharges([
    { adjustment: a, basis: '1000', amount: '250.00' },
    { adjustment: a, basis: '2000', amount: '250.00' },
  ])
  assert.equal(merged[0]!.amount, '250.00')
})

test('a zero or absent rate produces no charge', () => {
  assert.equal(priceAdjustments([labor('1000.00')], [adjustment({ value: '0' })]).length, 0)
  assert.equal(priceAdjustments([labor('1000.00')], [adjustment({ value: null })]).length, 0)
})

test('a customer-targeted adjustment charges only that customer', () => {
  const a = adjustment({ targets: [{ targetType: 'customer', targetValueId: 'cust-a', targetValueText: null }] })
  const lines = [
    { ...labor('1000.00'), customerId: 'cust-a' },
    { ...labor('2000.00'), customerId: 'cust-b' },
  ]
  const charges = priceAdjustments(lines, [a])
  assert.equal(charges.length, 1)
  assert.equal(charges[0]!.basis, '1000.0000')
})

test('a location-targeted adjustment charges only that location', () => {
  const a = adjustment({ targets: [{ targetType: 'location', targetValueId: 'loc-a', targetValueText: null }] })
  const lines: AdjustableLine[] = [
    { amount: '500.00', isLabor: false, locationId: 'loc-a' },
    { amount: '700.00', isLabor: false, locationId: 'loc-b' },
  ]
  const charges = priceAdjustments(lines, [a])
  assert.equal(charges.length, 1)
  assert.equal(charges[0]!.basis, '500.0000')
})

test('a targeted adjustment with no line context matches nothing, never everything', () => {
  for (const targetType of ['customer', 'project', 'subsidiary', 'location', 'class']) {
    const a = adjustment({ targets: [{ targetType, targetValueId: 'some-id', targetValueText: null }] })
    assert.equal(priceAdjustments([labor('1000.00')], [a]).length, 0, targetType)
  }
})
