import test from 'node:test'
import assert from 'node:assert/strict'
import { coerceField } from './coerce.ts'
import type { SetupField } from './registry.ts'

const countryField: SetupField = { key: 'country', kind: 'country' }

test('setup country fields normalize and validate against the ISO country list', () => {
  assert.deepEqual(coerceField(countryField, ' ca '), { column: 'country', value: 'CA' })
  assert.deepEqual(coerceField(countryField, ''), { column: 'country', value: null })
  assert.deepEqual(coerceField(countryField, 'AA'), { error: 'country must be a valid ISO country code' })
})
