import test from 'node:test'
import assert from 'node:assert/strict'
import { isCountryCode, normalizeCountryCode } from './countries.ts'

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
