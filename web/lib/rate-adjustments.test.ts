import assert from 'node:assert/strict'
import test from 'node:test'
import {
  lineMatchesAdjustment,
  mergeCharges,
  mulPercentExact,
  priceAdjustments,
  RateAdjustmentPricingError,
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

test('a labor target measures labor only', () => {
  const a = adjustment({ targets: [{ targetType: 'labor', targetValueId: null, targetValueText: 'labor' }] })
  const charges = priceAdjustments([labor('1000.00'), { amount: '400.00', isLabor: false }], [a])
  assert.equal(charges.length, 1)
  assert.equal(charges[0]!.basis, '1000.0000')
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

test('an item_category target measures only that category', () => {
  const a = adjustment({ targets: [{ targetType: 'item_category', targetValueId: null, targetValueText: 'Consulting' }] })
  const lines: AdjustableLine[] = [
    { amount: '1000.00', isLabor: true, itemCategory: 'Consulting' },
    { amount: '2000.00', isLabor: true, itemCategory: 'Travel' },
  ]
  const charges = priceAdjustments(lines, [a])
  assert.equal(charges.length, 1)
  assert.equal(charges[0]!.basis, '1000.0000')
})

test('a trade target measures every active role the worker holds', () => {
  const a = adjustment({ targets: [{ targetType: 'trade', targetValueId: 'trade-electric', targetValueText: null }] })
  const matched = priceAdjustments(
    [{ ...labor('1000.00'), tradeIds: ['trade-plumbing', 'trade-electric'] }], [a])
  assert.equal(matched.length, 1)
  const unmatched = priceAdjustments(
    [{ ...labor('1000.00'), tradeIds: ['trade-plumbing'] }], [a])
  assert.equal(unmatched.length, 0)
  assert.equal(priceAdjustments([labor('1000.00')], [a]).length, 0)
})

test('a percent stored past 4dp prices instead of throwing', () => {
  // The save keeps 10dp; the old 4dp percent reader threw on these, so a
  // 3.123456% surcharge made invoice generation throw.
  const a = adjustment({ value: '3.123456' })
  const [charge] = priceAdjustments([labor('1000.00')], [a])
  assert.equal(charge!.amount, '31.2300')
})

test('a ten-decimal percent rounds the exact result once', () => {
  assert.equal(mulPercentExact('100.00', '33.3333333333'), '33.3300')
  assert.equal(mulPercentExact('1000.00', '3.1234567891'), '31.2300')
  // 0.05% of 10.00 is 0.005: halves away from zero, never truncated.
  assert.equal(mulPercentExact('10.00', '0.05'), '0.0100')
  assert.equal(mulPercentExact('10.00', '0.05', 4), '0.0050')
})

test('a non-numeric percent is refused by name', () => {
  assert.throws(() => mulPercentExact('100.00', 'abc'), RateAdjustmentPricingError)
  assert.throws(() => mulPercentExact('100.00', '1.00000000001'), RateAdjustmentPricingError)
})

test('a per-hour allowance multiplies the matched hours', () => {
  const a = adjustment({ calculation: 'per_hour', value: '5.00' })
  const lines = [
    { ...labor('1000.00'), quantity: '10' },
    { ...labor('500.00'), quantity: '4.5' },
  ]
  const [charge] = priceAdjustments(lines, [a])
  assert.equal(charge!.quantityBasis, '14.5')
  assert.equal(charge!.amount, '72.5000')
})

test('a per-day allowance counts distinct work dates', () => {
  const a = adjustment({ calculation: 'per_day', value: '50.00' })
  const lines: AdjustableLine[] = [
    { amount: '800.00', isLabor: true, quantity: '8', workedOn: '2026-07-14' },
    { amount: '800.00', isLabor: true, quantity: '8', workedOn: '2026-07-14' },
    { amount: '800.00', isLabor: true, quantity: '8', workedOn: '2026-07-15' },
  ]
  const [charge] = priceAdjustments(lines, [a])
  assert.equal(charge!.quantityBasis, '2')
  assert.equal(charge!.amount, '100.0000')
})

test('a per-hour charge with no hours is refused, never zero', () => {
  const a = adjustment({ calculation: 'per_hour', value: '5.00' })
  assert.throws(
    () => priceAdjustments([{ ...labor('100.00'), quantity: null }], [a]),
    RateAdjustmentPricingError,
  )
})

test('an unknown calculation throws naming the adjustment', () => {
  const a = adjustment({ calculation: 'distance' as never })
  assert.throws(() => priceAdjustments([labor('100.00')], [a]), /"distance"/)
})

test('informational text never adds an amount', () => {
  const a = adjustment({ calculation: 'text', value: null })
  assert.equal(priceAdjustments([labor('100.00')], [a]).length, 0)
})

test("a job_title target measures the worker's titles", () => {
  const a = adjustment({ targets: [{ targetType: 'job_title', targetValueId: null, targetValueText: 'Foreman' }] })
  const matched = priceAdjustments(
    [{ ...labor('1000.00'), jobTitles: ['Foreman'] }], [a])
  assert.equal(matched.length, 1)
  assert.equal(priceAdjustments(
    [{ ...labor('1000.00'), jobTitles: ['Apprentice'] }], [a]).length, 0)
})
