import test from 'node:test'
import assert from 'node:assert/strict'
import { INFORMATION_RETURN_FORMS } from '@openbooks/engine/src/information-returns.ts'
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
    'pay-schedules',
    'pay-components',
    'union-agreements',
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

test('compliance setup entities are gated and reachable from the rail', () => {
  const byGroup = setupEntitiesByGroup()
  assert.deepEqual(byGroup.get('compliance')?.map((entity) => entity.key), [
    'compliance-classes',
    'compliance-requirements',
    'information-return-box-rules',
  ])
  for (const key of ['compliance-classes', 'compliance-requirements', 'information-return-box-rules']) {
    const entity = SETUP_ENTITY_BY_KEY.get(key)
    assert.ok(entity, key)
    // Hiding the tab is presentation; the API re-checks this same key.
    assert.equal(entity.featureKey, 'subcontractorCompliance', key)
    assert.equal(entity.docSlug, 'subcontractor-compliance', key)
  }
})

test('every information-return box option is a real statutory box', () => {
  const rules = SETUP_ENTITY_BY_KEY.get('information-return-box-rules')
  assert.ok(rules)
  const offered = new Set(
    rules.fields.find((field) => field.key === 'box')?.options?.map((option) => option.value) ?? [],
  )
  assert.ok(offered.size > 0)
  const statutory = new Set(
    Object.values(INFORMATION_RETURN_FORMS).flatMap((form) => form.boxes.map((box) => box.key)),
  )
  for (const box of offered) {
    assert.ok(statutory.has(box), `${box} is offered in setup but is not a box on any form`)
  }
  for (const box of statutory) {
    assert.ok(offered.has(box), `${box} exists on a form but cannot be mapped in setup`)
  }
})
