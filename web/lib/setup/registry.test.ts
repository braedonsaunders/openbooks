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
