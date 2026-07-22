import test from 'node:test'
import assert from 'node:assert/strict'
import { SETUP_ENTITY_BY_KEY, setupEntitiesByGroup } from './registry.ts'

test('tax rates and return boxes are nested under their owning records', () => {
  const taxRates = SETUP_ENTITY_BY_KEY.get('tax-rates')
  const taxBoxes = SETUP_ENTITY_BY_KEY.get('tax-report-lines')
  assert.ok(taxRates)
  assert.ok(taxBoxes)
  assert.equal(taxRates.nestedUnder, 'tax-codes')
  assert.equal(taxBoxes.nestedUnder, 'tax-return-forms')
  assert.equal(taxRates.docSlug, 'tax-configuration')
  assert.equal(taxBoxes.docSlug, 'tax-configuration')

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
})
