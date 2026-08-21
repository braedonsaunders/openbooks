import assert from 'node:assert/strict'
import test from 'node:test'
import {
  POSTED_BASIS_EDIT_ERROR,
  assetBasisChanges,
  mergedAssetBasis,
  postedAssetBasisEditRefusal,
  type AssetDepreciationBasis,
} from './asset-basis-guard'

const basis = (over: Partial<AssetDepreciationBasis> = {}): AssetDepreciationBasis => ({
  acquisition_cost: '12000.0000',
  salvage_value: '1000.0000',
  useful_life_months: 60,
  in_service_on: '2026-01-01',
  depreciation_rate_percent: null,
  depreciation_units_total: null,
  depreciation_convention: 'full_month',
  depreciation_method: 'straight_line',
  depreciation_method_id: null,
  ...over,
})

type RequestedShape = Parameters<typeof postedAssetBasisEditRefusal>[2]

test('Edits before anything has posted are never refused, whatever they change', () => {
  const existing = basis()
  const everything: RequestedShape = {
    cost: '9000',
    salvage: '0',
    lifeMonths: null,
    inServiceOn: '2026-03-01',
    ratePercent: '30',
    unitsTotal: '10000',
    convention: 'half_year',
    method: 'declining_balance',
    depreciationMethodId: null,
  }
  assert.equal(postedAssetBasisEditRefusal(false, existing, everything), null)
})

test('A resave of unchanged values on a posted asset passes — the flyout resends every field', () => {
  const existing = basis()
  // Same values in different string forms must not read as a change.
  const resent = {
    cost: '12000',
    salvage: '1000.0',
    lifeMonths: 60,
    inServiceOn: '2026-01-01',
    convention: 'full_month',
    method: 'straight_line',
    depreciationMethodId: null,
  }
  assert.deepEqual(assetBasisChanges(existing, resent), [])
  assert.equal(postedAssetBasisEditRefusal(true, existing, resent), null)
  assert.equal(postedAssetBasisEditRefusal(true, existing, {}), null)
})

test('Any basis change on a posted asset is refused with the controlled-adjustment message', () => {
  const existing = basis()
  const cases: RequestedShape[] = [
    { cost: '15000' },
    { cost: '11000' }, // decreases too — NBV below salvage is not an edit outcome
    { salvage: '2000' },
    { lifeMonths: 72 },
    { inServiceOn: '2026-02-01' },
    { convention: 'mid_month' },
    { method: 'double_declining' },
    { depreciationMethodId: '5b5d1c58-86a3-4b18-9f61-2e7bd0e35f01' },
    { ratePercent: '40' },
    { unitsTotal: '50000' },
    { lifeMonths: null }, // clearing a set value is a change
  ]
  for (const request of cases) {
    assert.equal(postedAssetBasisEditRefusal(true, existing, request), POSTED_BASIS_EDIT_ERROR)
  }
})

test('Non-basis edits pass even on a posted asset', () => {
  // The guard only sees basis fields; name/account/status changes never reach it.
  assert.equal(postedAssetBasisEditRefusal(true, basis(), {}), null)
})

test('Changed fields are reported by stored column name and merge to the audited after-state', () => {
  const existing = basis({ depreciation_rate_percent: null })
  const requested = { cost: '13000.0000', ratePercent: '30.00', convention: 'half_year' as const }
  assert.deepEqual(assetBasisChanges(existing, requested), [
    'acquisition_cost',
    'depreciation_rate_percent',
    'depreciation_convention',
  ])
  const after = mergedAssetBasis(existing, requested)
  assert.equal(after.acquisition_cost, '13000.0000')
  assert.equal(after.depreciation_rate_percent, '30.00')
  assert.equal(after.depreciation_convention, 'half_year')
  assert.equal(after.useful_life_months, 60)
  // An empty request projects the stored row untouched.
  assert.deepEqual(mergedAssetBasis(existing, {}), existing)
})
