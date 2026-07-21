import test from 'node:test'
import assert from 'node:assert/strict'
import { SETUP_ENTITY_BY_KEY, setupEntitiesByGroup } from './registry.ts'

test('tax return boxes are nested under tax codes instead of appearing in the setup rail', () => {
  const taxBoxes = SETUP_ENTITY_BY_KEY.get('tax-report-lines')
  assert.ok(taxBoxes)
  assert.equal(taxBoxes.nestedUnder, 'tax-codes')
  assert.equal(taxBoxes.docSlug, 'tax-configuration')

  const visibleTaxKeys = setupEntitiesByGroup().get('taxes')?.map((entity) => entity.key)
  assert.ok(visibleTaxKeys?.includes('tax-codes'))
  assert.ok(!visibleTaxKeys?.includes('tax-report-lines'))
})
