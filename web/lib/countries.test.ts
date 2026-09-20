import test from 'node:test'
import assert from 'node:assert/strict'
import { COUNTRY_CODES, countryName, countryOptions, isCountryCode, normalizeCountryCode } from './countries.ts'

test('country codes are validated against ISO 3166-1, not their shape alone', () => {
  assert.equal(isCountryCode('CA'), true)
  assert.equal(isCountryCode('ca'), false)
  assert.equal(isCountryCode('AA'), false)
  assert.equal(isCountryCode('CAN'), false)
})

test('country code input is trimmed and normalized before validation', () => {
  assert.equal(normalizeCountryCode(' ca '), 'CA')
  assert.equal(normalizeCountryCode('AA'), null)
  assert.equal(normalizeCountryCode(''), null)
  assert.equal(normalizeCountryCode(null), null)
})

// Country names come from Intl, never a hardcoded map: a newly installed
// pack needs no edit here, and no message-catalog keys are needed.

test('countryName renders a known code in the requested locale', () => {
  assert.equal(countryName('JP', 'en'), 'Japan')
  assert.equal(countryName('SG', 'en'), 'Singapore')
})

// The locale must actually reach Intl: a helper that ignores it passes
// every single-locale test while showing every operator English names.
test('countryName honors its locale argument', () => {
  assert.equal(countryName('JP', 'fr'), 'Japon')
  assert.notEqual(countryName('JP', 'en'), countryName('JP', 'fr'))
  assert.notEqual(countryName('DE', 'en'), countryName('DE', 'fr'))
})

// The fallback is the test that matters: an unrecognised code renders as
// itself and never as an invented name — with fourteen packs and seven UI
// locales, "this locale does not know this region" is the normal case.
test('countryName falls back to the code itself, never an invented name', () => {
  assert.equal(countryName('XX', 'en'), 'XX')
  assert.equal(countryName('XX', 'fr'), 'XX')
})

// Intl throws RangeError on structurally invalid codes; the helper must fail
// visible (the code itself) rather than fail fatal (taking the page down).
test('countryName never throws on unrenderable codes', () => {
  assert.equal(countryName('', 'en'), '')
  assert.equal(countryName('1A', 'en'), '1A')
  assert.doesNotThrow(() => countryName('', 'en'))
  assert.doesNotThrow(() => countryName('1A', 'en'))
  assert.doesNotThrow(() => countryName('XX', 'en'))
})

// countryOptions now delegates to countryName, so this pins the refactor as
// behaviour-preserving: every option's label is exactly the single-code
// name, values stay codes, and the localeCompare sort order is unchanged.
test('countryOptions labels match countryName and stay sorted by label', () => {
  for (const locale of ['en', 'fr']) {
    const options = countryOptions(locale)
    assert.equal(options.length, COUNTRY_CODES.length)
    for (const option of options) {
      assert.equal(option.label, countryName(option.value, locale))
    }
    const labels = options.map((option) => option.label)
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, locale))
    assert.deepEqual(labels, sorted)
  }
})

test('countryOptions carries a real code and the code-fallback rule', () => {
  const options = countryOptions('en')
  assert.equal(options.find((option) => option.value === 'JP')?.label, 'Japan')
  // The fallback rule lives in countryName alone: an unassigned code renders
  // as itself there, so any option list built from it inherits the rule.
  assert.equal(countryName('XX', 'en'), 'XX')
})
