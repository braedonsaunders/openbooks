import assert from 'node:assert/strict'
import test from 'node:test'
import { CONTROL_ACCOUNT_TYPE_POLICY } from '@openbooks/engine/src/records/control-accounts.ts'
import { accountTypeMessageKey, controlAccountPickerOptions } from './control-account-options'

const CHART = [
  { id: 'bank', label: '1000 · Operating', type: 'asset_bank' },
  { id: 'clearing', label: '1250 · Labor clearing', type: 'asset_current_other' },
  { id: 'accrued', label: '2100 · Accrued', type: 'liability_current_other' },
  { id: 'reserve', label: '3300 · Translation reserve', type: 'equity' },
  { id: 'sales', label: '4000 · Sales', type: 'income' },
]
const flag = (label: string) => `${label} (not accepted)`

test('a picker offers only the account types the role policy accepts', () => {
  const translation = controlAccountPickerOptions({
    accounts: CHART,
    allowedTypes: CONTROL_ACCOUNT_TYPE_POLICY.translationAdjustment,
    selectedId: undefined,
    incompatibleLabel: flag,
  })
  assert.deepEqual(translation.options.map((option) => option.value), ['reserve'])
  assert.equal(translation.selectedIncompatible, false)

  const labor = controlAccountPickerOptions({
    accounts: CHART,
    allowedTypes: CONTROL_ACCOUNT_TYPE_POLICY.laborClearing,
    selectedId: 'clearing',
    incompatibleLabel: flag,
  })
  assert.deepEqual(labor.options.map((option) => option.value), ['clearing', 'accrued'])
  assert.equal(labor.selectedIncompatible, false)
})

test('a stored mapping outside the policy stays visible and is flagged', () => {
  const picker = controlAccountPickerOptions({
    accounts: CHART,
    allowedTypes: CONTROL_ACCOUNT_TYPE_POLICY.translationAdjustment,
    selectedId: 'sales',
    incompatibleLabel: flag,
  })
  assert.equal(picker.selectedIncompatible, true)
  assert.deepEqual(picker.options[0], { value: 'sales', label: '4000 · Sales (not accepted)' })
  assert.deepEqual(picker.options.slice(1).map((option) => option.value), ['reserve'])
})

test('every policy account type maps onto its accounts.types message key', async () => {
  const types = new Set(Object.values(CONTROL_ACCOUNT_TYPE_POLICY).flat())
  const accountTypes = (await import('../../../../messages/en/accounts.json', { with: { type: 'json' } }))
    .default.types as Record<string, string>
  for (const type of types) {
    assert.ok(accountTypes[accountTypeMessageKey(type)], `${type} must have an accounts.types label`)
  }
  assert.equal(accountTypeMessageKey('asset_current_other'), 'assetCurrentOther')
})
