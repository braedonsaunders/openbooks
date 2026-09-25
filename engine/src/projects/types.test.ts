import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_PROJECT_TYPES } from '@openbooks/schema'
import { assertValidProjectFinancialProfile } from './financial-profile-versions.ts'

test('every built-in project type declares an explicit billing procedure', () => {
  assert.ok(BUILTIN_PROJECT_TYPES.length >= 5)
  for (const type of BUILTIN_PROJECT_TYPES) {
    assert.ok(['standard', 'application_for_payment'].includes(type.invoicingProfile.billingProcedure))
  }
})

test('schedule-of-values billing is a fixed-price project procedure', () => {
  const type = BUILTIN_PROJECT_TYPES.find((candidate) => candidate.key === 'schedule_of_values')
  if (!type) throw new Error('schedule_of_values built-in is missing')
  assert.equal(type.billingMethod, 'fixed_price')
  assert.equal(type.invoicingProfile.billingProcedure, 'application_for_payment')
  assert.deepEqual(type.invoicingProfile.allowedBases, ['draw_amount'])
})

test('fixed-price time is cost evidence unless an explicit work basis bills it', () => {
  const type = BUILTIN_PROJECT_TYPES.find((candidate) => candidate.key === 'fixed_price')
  if (!type) throw new Error('fixed_price built-in is missing')
  assert.equal(type.financialProfile.totalPrice.method, 'contract_field')
  assert.equal(type.invoicingProfile.defaultBasis, 'milestone')
  assert.equal(type.invoicingProfile.lineBuilder, 'milestone')
})

test('tenant project forecasts may explicitly include source rejected documents', () => {
  const builtIn = BUILTIN_PROJECT_TYPES.find(
    (candidate) => candidate.key === 'time_and_materials',
  )
  if (!builtIn) throw new Error('time_and_materials built-in is missing')
  const profile = structuredClone(builtIn.financialProfile)
  profile.committedCost.statuses = [
    'pending_approval',
    'approved',
    'rejected',
  ]
  profile.billableValue.costSourceStatuses = [
    'pending_approval',
    'approved',
    'posted',
    'rejected',
  ]
  assert.doesNotThrow(() => assertValidProjectFinancialProfile(profile))

  const invalid = structuredClone(profile) as unknown as {
    committedCost: { statuses: string[] }
  }
  invalid.committedCost.statuses = ['voided']
  assert.throws(
    () => assertValidProjectFinancialProfile(invalid),
    /committedCost\.statuses contains an unsupported lifecycle/,
  )
})

test('account-group labor without a dimension is refused at the profile boundary', () => {
  const builtIn = BUILTIN_PROJECT_TYPES.find(
    (candidate) => candidate.key === 'time_and_materials',
  )
  if (!builtIn) throw new Error('time_and_materials built-in is missing')
  const profile = structuredClone(builtIn.financialProfile)
  profile.laborCost = { source: 'account_group' }
  assert.throws(
    () => assertValidProjectFinancialProfile(profile),
    /laborCost\.dimension is required/,
  )
  profile.laborCost = { source: 'account_group', dimension: 'labor_pool', groupKeys: ['field_labor'] }
  assert.doesNotThrow(() => assertValidProjectFinancialProfile(profile))
})
