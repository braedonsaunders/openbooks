import assert from 'node:assert/strict'
import test from 'node:test'
import { isBlankRateBookLine, validateRateBookLines } from './item-rate-book-lines.ts'

const ITEM = '11111111-1111-4111-8111-111111111111'

function line(overrides: Record<string, unknown> = {}) {
  return {
    itemId: ITEM, unitCode: 'hour', unitName: 'Hour', baseQuantity: '1',
    costRate: '0', billRate: '100', baseUnit: 'hour',
    pricingPolicy: 'capped_ladder', invoicePresentation: 'rate_components',
    timeTypeBillRates: {},
    ...overrides,
  }
}

test('a truly blank placeholder row is skipped', () => {
  const result = validateRateBookLines([{ itemId: '', unitCode: '', unitName: '', baseQuantity: '', costRate: '', billRate: '', baseUnit: '', pricingPolicy: '', invoicePresentation: '', timeTypeBillRates: {} }, line()])
  assert.ok('lines' in result)
  assert.equal(result.lines.length, 1)
})

test('a fully empty row is skipped', () => {
  assert.ok(isBlankRateBookLine({ itemId: '', unitCode: '', unitName: '', baseQuantity: '', costRate: '', billRate: '', baseUnit: '', pricingPolicy: '', invoicePresentation: '', timeTypeBillRates: {} }))
  assert.ok(isBlankRateBookLine({}))
})

test('a row with rates but no item is refused by index naming the item', () => {
  const result = validateRateBookLines([{ baseQuantity: '1', billRate: '100', costRate: '50' }])
  assert.ok('error' in result)
  assert.match(result.error, /^Row 1: choose an item/)
})

test('a fresh add-row with default quantities still names the missing item', () => {
  const result = validateRateBookLines([{
    itemId: '', unitCode: '', unitName: '', baseQuantity: '1', costRate: '0', billRate: '0',
    baseUnit: '', pricingPolicy: 'capped_ladder', invoicePresentation: 'rate_components', timeTypeBillRates: {},
  }])
  assert.ok('error' in result)
  assert.match(result.error, /^Row 1: choose an item/)
})

test('later rows are numbered by position', () => {
  const result = validateRateBookLines([line(), { ...line(), unitCode: 'hour', itemId: 'not-a-uuid' }])
  assert.ok('error' in result)
  assert.match(result.error, /^Row 2: choose an item/)
})

test('excess precision and over-wide amounts name the row', () => {
  assert.match((validateRateBookLines([{ ...line(), baseQuantity: '1.00005' }]) as { error: string }).error, /^Row 1: base quantities and rates must be exact numbers with no more than four decimal places/)
  assert.match((validateRateBookLines([{ ...line(), billRate: '9999999999999999.0000' }]) as { error: string }).error, /^Row 1: rate amounts may contain at most 15 whole-number digits/)
})

test('missing units, base unit and premium shapes name the row', () => {
  assert.match((validateRateBookLines([{ ...line(), unitCode: '', unitName: '' }]) as { error: string }).error, /^Row 1: every rate line needs a unit code/)
  assert.match((validateRateBookLines([{ ...line(), baseUnit: '' }]) as { error: string }).error, /^Row 1: every rate line needs a base unit/)
  assert.match((validateRateBookLines([{ ...line(), timeTypeBillRates: 'hourly' }]) as { error: string }).error, /^Row 1: labor premiums must map/)
  const badKey = validateRateBookLines([{ ...line(), timeTypeBillRates: { nope: '5' } }]) as { error: string }
  assert.match(badKey.error, /^Row 1: labor premium "nope" is not a valid time type/)
})

test('premium values pass structural validation for the shared validator', () => {
  // Org membership and amounts are the shared validator's job (route-level,
  // DB-backed); the line validator only checks the map shape.
  const result = validateRateBookLines([line({ timeTypeBillRates: { [ITEM]: 'fifty' } })])
  assert.ok('lines' in result)
  assert.deepEqual(result.lines[0]!.timeTypeBillRates, {})
})

test('a non-object rate line is refused, never skipped', () => {
  const result = validateRateBookLines(['oops'])
  assert.ok('error' in result)
  assert.match(result.error, /^Row 1: rate line must be an object/)
})
