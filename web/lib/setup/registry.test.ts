import test from 'node:test'
import assert from 'node:assert/strict'
import { SETUP_ENTITY_BY_KEY, setupEntitiesByGroup, setupEntityForFeatureState } from './registry.ts'

test('tax rates and return boxes are nested under their owning records', () => {
  const taxRates = SETUP_ENTITY_BY_KEY.get('tax-rates')
  const taxBoxes = SETUP_ENTITY_BY_KEY.get('tax-report-lines')
  assert.ok(taxRates)
  assert.ok(taxBoxes)
  assert.equal(taxRates.nestedUnder, 'tax-codes')
  assert.equal(taxBoxes.nestedUnder, 'tax-return-forms')
  assert.equal(taxRates.docSlug, 'tax-configuration')
  assert.equal(taxBoxes.docSlug, 'tax-returns-and-boxes')

  const visibleTaxKeys = setupEntitiesByGroup().get('taxes')?.map((entity) => entity.key)
  assert.ok(visibleTaxKeys?.includes('tax-codes'))
  assert.ok(visibleTaxKeys?.includes('tax-return-forms'))
  assert.ok(!visibleTaxKeys?.includes('tax-rates'))
  assert.ok(!visibleTaxKeys?.includes('tax-report-lines'))
})

test('re-homed entities stay in the CRUD registry but leave the setup rail', () => {
  const rehomed = [
    'stock-locations',
    'bom-components',
    'item-inventory-profiles',
    'item-rate-books',
    'item-rate-book-assignments',
    'fair-value-prices',
    'tax-regimes',
    'tax-pool-classes',
    'tax-first-year-rules',
    'depreciation-methods',
    'depreciation-book-policies',
  ]
  const byGroup = setupEntitiesByGroup()
  const allVisible = [...byGroup.values()].flat().map((entity) => entity.key)
  for (const key of rehomed) {
    const entity = SETUP_ENTITY_BY_KEY.get(key)
    assert.ok(entity, `${key} must remain resolvable for the shared API`)
    assert.equal(entity.rehomed, true, `${key} must be marked rehomed`)
    assert.ok(!allVisible.includes(key), `${key} must not appear in the setup rail`)
  }

  // The Inventory setup group is now empty — all three moved to the module.
  assert.equal(byGroup.get('inventory')?.length, 0)
  assert.deepEqual(byGroup.get('assets')?.map((entity) => entity.key), ['asset-categories'])
})

test('time types independently control field-ticket visibility', () => {
  const timeTypes = SETUP_ENTITY_BY_KEY.get('time-types')
  assert.ok(timeTypes)
  assert.ok(timeTypes.fields.some((field) => field.key === 'showOnFieldTicket' && field.kind === 'boolean'))
  assert.ok(timeTypes.columns.some((column) => column.key === 'showOnFieldTicket' && column.kind === 'boolean'))
})

test('number sequences use friendly record choices and explain gapless numbering', () => {
  const sequence = SETUP_ENTITY_BY_KEY.get('number-sequences')
  assert.ok(sequence)
  assert.ok(sequence.columns.some((column) => column.key === 'documentKind' && column.ref === 'number-sequence-kinds'))
  assert.ok(sequence.fields.some((field) => field.key === 'documentKind' && field.kind === 'ref' && field.ref === 'number-sequence-kinds'))
  assert.ok(sequence.fields.some((field) => field.key === 'gapless' && field.helpTextKey === 'fieldHelp.gapless'))
})

test('generic setup subsidiary controls follow the feature flag everywhere', () => {
  for (const key of ['number-sequences', 'classes', 'departments', 'locations']) {
    const entity = SETUP_ENTITY_BY_KEY.get(key)
    assert.ok(entity)
    const enabled = setupEntityForFeatureState(entity, { multiSubsidiary: true })
    assert.ok(enabled.fields.some((field) => field.ref === 'subsidiaries'), `${key} must expose subsidiary scope when enabled`)

    const disabled = setupEntityForFeatureState(entity, { multiSubsidiary: false })
    assert.ok(!disabled.fields.some((field) => field.ref === 'subsidiaries' || field.key === 'subsidiaryIncludeChildren'))
    assert.ok(!disabled.columns.some((column) => column.ref === 'subsidiaries'))
  }
})
