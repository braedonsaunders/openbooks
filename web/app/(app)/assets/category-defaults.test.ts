import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCategoryDefaults, categoryDefaultFields } from './category-defaults'

const SELECTABLE = new Set(['1500', '1510', '6600', '1520', '1530', '6610'])
const EQUIPMENT = {
  id: 'equipment', asset_account_id: '1500', accumulated_depreciation_account_id: '1510',
  depreciation_expense_account_id: '6600', default_method: 'straight_line',
  default_depreciation_method_id: null, default_life_months: 60, default_convention: 'full_month',
}
const VEHICLES = {
  id: 'vehicles', asset_account_id: '1520', accumulated_depreciation_account_id: '1530',
  depreciation_expense_account_id: '6610', default_method: 'declining_balance',
  default_depreciation_method_id: null, default_life_months: 36, default_convention: 'half_year',
}

test('a category supplies its accounts, method, life and convention', () => {
  assert.deepEqual(categoryDefaultFields(EQUIPMENT, SELECTABLE), {
    assetAccountId: '1500', accumAccountId: '1510', expenseAccountId: '6600',
    method: 'straight_line', depreciationMethodId: '', lifeMonths: '60', convention: 'full_month',
  })
})

test('an account outside the selectable set is left blank instead of shown unselectable', () => {
  const restricted = categoryDefaultFields(EQUIPMENT, new Set(['1510', '6600']))
  assert.equal(restricted.assetAccountId, '')
  assert.equal(restricted.accumAccountId, '1510')
})

test('switching category replaces untouched defaults and keeps operator overrides', () => {
  const equipment = categoryDefaultFields(EQUIPMENT, SELECTABLE)
  const vehicles = categoryDefaultFields(VEHICLES, SELECTABLE)
  const edited = { ...equipment, expenseAccountId: '6610', lifeMonths: '84' }
  const switched = applyCategoryDefaults(edited, equipment, vehicles)
  assert.equal(switched.assetAccountId, '1520')
  assert.equal(switched.accumAccountId, '1530')
  assert.equal(switched.expenseAccountId, '6610', 'an operator-chosen account survives')
  assert.equal(switched.lifeMonths, '84', 'an operator-chosen life survives')
  assert.equal(switched.method, 'declining_balance')
  assert.equal(switched.convention, 'half_year')
})

test('blank fields take the new category default even with no previous category', () => {
  const blank = { assetAccountId: '', accumAccountId: '', expenseAccountId: '', method: 'straight_line', depreciationMethodId: '', lifeMonths: '', convention: 'full_month' }
  const switched = applyCategoryDefaults(blank, null, categoryDefaultFields(VEHICLES, SELECTABLE))
  assert.equal(switched.assetAccountId, '1520')
  assert.equal(switched.lifeMonths, '36')
  assert.equal(switched.method, 'straight_line', 'without a previous default the method choice is the operator\'s')
})

test('a formula method follows the category as one choice with its built-in pairing', () => {
  const formula = categoryDefaultFields({ ...VEHICLES, default_depreciation_method_id: 'formula-1' }, SELECTABLE)
  const equipment = categoryDefaultFields(EQUIPMENT, SELECTABLE)
  const switched = applyCategoryDefaults(equipment, equipment, formula)
  assert.equal(switched.depreciationMethodId, 'formula-1')
  const back = applyCategoryDefaults(switched, formula, equipment)
  assert.equal(back.depreciationMethodId, '')
  assert.equal(back.method, 'straight_line')
})
