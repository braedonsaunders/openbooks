// Boundary behaviour of item shipping fields: usable values normalize to
// storage shape, and every unusable value refuses by name with its remedy —
// never a raw CHECK, never a silent clear.
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseItemShippingFields } from './shipping-item-fields.ts'

test('usable shipping fields normalize to storage shape', () => {
  const parsed = parseItemShippingFields({
    weight: '2.5',
    weightUnit: 'kg',
    dimensions: { length: '30', width: '', height: '20', unit: 'cm' },
    hsCode: ' 8471.30 ',
    countryOfOrigin: 'us',
  })
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.deepEqual(parsed.values, {
      weight: '2.5000',
      weightUnit: 'kg',
      dimensions: { length: '30.0000', width: null, height: '20.0000', unit: 'cm' },
      hsCode: '8471.30',
      countryOfOrigin: 'US',
    })
  }
})

test('absent shipping fields stay absent, never silent clears', () => {
  const parsed = parseItemShippingFields({})
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.deepEqual(parsed.values, {})
})

test('explicit nulls clear stored shipping values', () => {
  const parsed = parseItemShippingFields({ weight: null, hsCode: null, countryOfOrigin: null })
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.values.weight, null)
    assert.equal(parsed.values.hsCode, null)
    assert.equal(parsed.values.countryOfOrigin, null)
  }
})

test('an unreadable weight refuses by name', () => {
  const parsed = parseItemShippingFields({ weight: 'twelve' })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /Weight "twelve" is not a number/)
})

test('a non-positive weight refuses by name', () => {
  const parsed = parseItemShippingFields({ weight: '0' })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /Weight must be positive/)
})

test('an unknown weight unit refuses by name', () => {
  const parsed = parseItemShippingFields({ weightUnit: 'stone' })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /Weight unit must be g, kg, oz or lb/)
})

test('a bad dimension refuses by name', () => {
  const parsed = parseItemShippingFields({ dimensions: { length: 'wide', width: null, height: null, unit: 'cm' } })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /Length "wide" is not a number/)
})

test('a bad dimension unit refuses by name', () => {
  const parsed = parseItemShippingFields({ dimensions: { length: '1', width: null, height: null, unit: 'parsec' } })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /Dimension unit must be cm or in/)
})

test('a non-country origin refuses by name', () => {
  const parsed = parseItemShippingFields({ countryOfOrigin: 'USA' })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /two-letter country code/)
})

test('an overlong HS code refuses by name', () => {
  const parsed = parseItemShippingFields({ hsCode: '1'.repeat(25) })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.message, /at most 24 characters/)
})

test('non-text shipping values never become silent clears', () => {
  for (const body of [{ weight: 5 }, { hsCode: 8471 }, { countryOfOrigin: ['US'] }, { dimensions: '30x20' }]) {
    const parsed = parseItemShippingFields(body)
    assert.equal(parsed.ok, false, JSON.stringify(body))
  }
})
