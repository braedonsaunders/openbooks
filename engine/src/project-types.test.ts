import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_PROJECT_TYPES } from '@openbooks/schema'

test('every built-in project type declares an explicit billing procedure', () => {
  assert.ok(BUILTIN_PROJECT_TYPES.length >= 5)
  for (const type of BUILTIN_PROJECT_TYPES) {
    assert.ok(['standard', 'application_for_payment'].includes(type.invoicingProfile.billingProcedure ?? ''))
  }
})

test('schedule-of-values billing is a fixed-price project procedure', () => {
  const type = BUILTIN_PROJECT_TYPES.find((candidate) => candidate.key === 'schedule_of_values')
  if (!type) throw new Error('schedule_of_values built-in is missing')
  assert.equal(type.billingMethod, 'fixed_price')
  assert.equal(type.invoicingProfile.billingProcedure, 'application_for_payment')
  assert.deepEqual(type.invoicingProfile.allowedBases, ['draw_amount'])
})
