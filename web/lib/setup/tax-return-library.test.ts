import test from 'node:test'
import assert from 'node:assert/strict'
import { planTaxReturnLibraryChange } from './tax-return-library.ts'

const known = new Set(['CA_GST34', 'GB_VAT100', 'AU_BAS_GST'])

test('bulk install deduplicates packs and never resets an installed return', () => {
  assert.deepEqual(
    planTaxReturnLibraryChange(
      { mode: 'install', packs: ['CA_GST34', 'GB_VAT100', 'GB_VAT100'] },
      known,
      new Set(['CA_GST34']),
    ),
    {
      mode: 'install',
      requested: ['CA_GST34', 'GB_VAT100'],
      targets: ['GB_VAT100'],
      skipped: ['CA_GST34'],
    },
  )
})

test('reset is explicit and limited to already-installed packs', () => {
  assert.deepEqual(
    planTaxReturnLibraryChange({ mode: 'reset', packs: ['CA_GST34'] }, known, new Set(['CA_GST34'])),
    { mode: 'reset', requested: ['CA_GST34'], targets: ['CA_GST34'], skipped: [] },
  )
  assert.deepEqual(
    planTaxReturnLibraryChange({ mode: 'reset', packs: ['GB_VAT100'] }, known, new Set(['CA_GST34'])),
    { error: 'pack-not-installed', status: 409 },
  )
})

test('bulk requests reject empty, oversized, and unknown pack sets', () => {
  assert.deepEqual(
    planTaxReturnLibraryChange({ mode: 'install', packs: [] }, known, new Set()),
    { error: 'invalid-request', status: 400 },
  )
  assert.deepEqual(
    planTaxReturnLibraryChange({ mode: 'install', packs: ['UNKNOWN'] }, known, new Set()),
    { error: 'unknown-pack', status: 422 },
  )
})
