import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { INFORMATION_RETURN_FORMS } from '@openbooks/engine/src/compliance/information-returns.ts'
import {
  SETUP_ENTITIES,
  SETUP_ENTITY_BY_KEY,
  SETUP_GROUPS,
  setupEntitiesByGroup,
  setupEntityForFeatureState,
  setupFieldVisible,
  type SetupField,
} from './registry.ts'

test('agents is a first-party setup group served by custom pages, not generic entities', () => {
  const agents = SETUP_GROUPS.find((group) => group.key === 'agents')
  assert.ok(agents, 'SETUP_GROUPS must list the agents category')
  assert.equal(agents.iconKey, 'sparkles')
  // The agents area (overview, library, policy, activity) is custom pages
  // under /admin/setup/agents/** — no generic CRUD entity may claim the
  // group, or the rail would render a second copy of the surface.
  const claimed = setupEntitiesByGroup().get('agents') ?? []
  assert.deepEqual(claimed.map((entity) => entity.key), [])
})

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
    'tax-qualifying-activity-cessations',
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

test('labor pricing setup entities follow the Projects parent gate', () => {
  for (const key of ['item-rate-books', 'item-rate-book-assignments']) {
    const entity = SETUP_ENTITY_BY_KEY.get(key)
    assert.ok(entity, key)
    assert.equal(entity.featureKey, 'projects', key)
  }
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
    const enabled = setupEntityForFeatureState(entity, { multiSubsidiary: true, equipment: true })
    assert.ok(enabled.fields.some((field) => field.ref === 'subsidiaries'), `${key} must expose subsidiary scope when enabled`)

    const disabled = setupEntityForFeatureState(entity, { multiSubsidiary: false, equipment: true })
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

test('time-type field-ticket visibility follows the Field Tickets feature flag', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('time-types')
  assert.ok(entity)
  const enabled = setupEntityForFeatureState(entity, { multiSubsidiary: true, equipment: true, fieldTickets: true })
  assert.ok(enabled.fields.some((field) => field.key === 'showOnFieldTicket'))
  assert.ok(enabled.columns.some((column) => column.key === 'showOnFieldTicket'))

  const disabled = setupEntityForFeatureState(entity, { multiSubsidiary: true, equipment: true, fieldTickets: false })
  assert.ok(!disabled.fields.some((field) => field.key === 'showOnFieldTicket'))
  assert.ok(!disabled.columns.some((column) => column.key === 'showOnFieldTicket'))
})

test('derived-rule equipment controls follow the Equipment feature flag', () => {
  const entity = SETUP_ENTITY_BY_KEY.get('pay-derived-rules')
  assert.ok(entity)
  const enabled = setupEntityForFeatureState(entity, { multiSubsidiary: true, equipment: true })
  assert.ok(enabled.fields.some((field) => field.key === 'equipmentUnitId'))
  assert.ok(enabled.fields.find((field) => field.key === 'trigger')?.options?.some((option) => option.value === 'equipment_charge'))
  assert.ok(enabled.filters?.find((filter) => filter.key === 'trigger')?.options.some((option) => option.value === 'equipment_charge'))

  const disabled = setupEntityForFeatureState(entity, { multiSubsidiary: true, equipment: false })
  assert.ok(!disabled.fields.some((field) => field.key === 'equipmentUnitId' || field.ref === 'equipment-units'))
  assert.ok(!disabled.fields.find((field) => field.key === 'trigger')?.options?.some((option) => option.value === 'equipment_charge'))
  assert.ok(!disabled.filters?.find((filter) => filter.key === 'trigger')?.options.some((option) => option.value === 'equipment_charge'))
})

test('derived-rule job-title lists are chip inputs fed by the roster, never raw JSON', () => {
  const rules = SETUP_ENTITY_BY_KEY.get('pay-derived-rules')
  assert.ok(rules)
  for (const key of ['includedJobTitles', 'excludedJobTitles']) {
    const field: SetupField | undefined = rules.fields.find((entry) => entry.key === key)
    assert.ok(field, `${key} must be editable on a derived rule`)
    assert.equal(field.kind, 'stringArray', `${key} must render as the TagInput, not a JSON textarea`)
    assert.equal(field.ref, 'job-titles', `${key} must type-ahead over the roster's job titles`)
  }
  // Raw JSON is never an acceptable UI: no payroll/workforce entity may
  // expose a `json`-kind field. (The one remaining `json` field in the whole
  // registry is asset-categories.taxAttributes — an object-shaped bag with no
  // natural structured editor yet, and not a payroll surface.)
  const byGroup = setupEntitiesByGroup()
  const workforce = [...(byGroup.get('workforce') ?? []), rules]
  for (const entity of workforce) {
    for (const field of entity.fields) {
      assert.notEqual(field.kind, 'json', `${entity.key}.${field.key} must not render as raw JSON`)
    }
  }
})

test('deduction protection is offered only where it can legally apply', () => {
  const components = SETUP_ENTITY_BY_KEY.get('pay-components')
  assert.ok(components)
  const field = (key: string) => {
    const found = components.fields.find((entry) => entry.key === key)
    assert.ok(found, `${key} must be editable on a pay component`)
    return found
  }

  // Protection settings on a deduction only — the pay_components CHECK
  // constraint enforces the same rule at the boundary.
  const earning = { kind: 'earning', basis: 'percent_of_gross', protectionBase: 'net_pay' }
  const deduction = { kind: 'deduction', basis: 'fixed_amount', protectionBase: 'net_pay' }
  assert.equal(setupFieldVisible(field('protectionBase'), earning), false)
  assert.equal(setupFieldVisible(field('protectionBase'), deduction), true)
  assert.equal(setupFieldVisible(field('protectionMaxPercent'), deduction), true)
  assert.equal(
    setupFieldVisible(field('protectionMaxPercent'), { ...deduction, protectionBase: 'none' }),
    false,
  )
  // Pool membership is what keeps an allowance or a benefit outside the base,
  // so it belongs on both sides of the stub.
  assert.equal(setupFieldVisible(field('includeInDisposableEarnings'), earning), true)
  assert.equal(setupFieldVisible(field('includeInDisposableEarnings'), deduction), true)

  // The hours cap only means something once the amount is driven by hours.
  assert.equal(setupFieldVisible(field('basisCapHoursPerPeriod'), deduction), false)
  assert.equal(setupFieldVisible(field('basisCapHoursPerPeriod'), earning), true)
  for (const key of ['basisCapAmountPerPeriod', 'basisCapAmountPerYear']) {
    assert.equal(setupFieldVisible(field(key), deduction), true)
  }
})

test('allocations is a feature-gated custom-page rail entry, never generic CRUD', () => {
  // The Rules | Drivers | Runs workspace is a custom ModuleView page
  // (allocation-kernel shard A7); the registry entry only puts the tab on the
  // setup rail under Accounting, gated by the `allocations` feature.
  const entry = SETUP_ENTITY_BY_KEY.get('allocations')
  assert.ok(entry, 'registry must declare the allocations entry')
  assert.equal(entry.groupKey, 'accounting')
  assert.equal(entry.featureKey, 'allocations')
  assert.equal(entry.table, 'allocation_rules')
  // The static custom page serves /admin/setup/allocations; the generic
  // [entity] CRUD surface must refuse every write so versioned rule config
  // only changes through the allocations API.
  assert.equal(entry.readOnly, true)
  assert.equal(entry.allowCreate, false)
  assert.equal(entry.allowDelete, false)
  // A rail entry, not a nested/rehomed record: it renders in the Accounting group.
  const rail = (setupEntitiesByGroup().get('accounting') ?? []).map((e) => e.key)
  assert.ok(rail.includes('allocations'), 'allocations must appear on the setup rail')
})

test('every static setup option labelKey resolves under admin.setup', () => {
  // The generic setup list/drawer translates option labelKeys against the
  // admin.setup namespace, so a key that misses its prefix renders raw
  // (time-type Classification showed "admin.setup.timeClassification.regular").
  const catalog = JSON.parse(
    readFileSync(new URL('../../messages/en/admin.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
  const setup = (catalog.setup ?? {}) as Record<string, unknown>
  const missing: string[] = []
  const seen = new Set<string>()
  for (const entity of SETUP_ENTITIES) {
    const carriers = [...entity.columns, ...entity.fields, ...(entity.filters ?? [])]
    for (const carrier of carriers) {
      for (const option of carrier.options ?? []) {
        if (!option.labelKey || seen.has(option.labelKey)) continue
        seen.add(option.labelKey)
        let node: unknown = setup
        for (const part of option.labelKey.split('.')) {
          node = (node as Record<string, unknown> | null)?.[part]
        }
        if (typeof node !== 'string' || node.length === 0) missing.push(`${entity.key}: ${option.labelKey}`)
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('every setup column, field and filter key has an English label under admin.setup.fields', () => {
  // The generic setup list/drawer renders headers and labels through
  // t(`fields.${key}`), so a registry key with no English source entry is
  // invisible to every locale pin (they compare against English) and renders
  // raw on the surface (F-coord-008).
  const catalog = JSON.parse(
    readFileSync(new URL('../../messages/en/admin.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>
  const fields = ((catalog.setup ?? {}) as Record<string, unknown>).fields as Record<string, unknown>
  const missing: string[] = []
  for (const entity of SETUP_ENTITIES) {
    const carriers = [...entity.columns, ...entity.fields, ...(entity.filters ?? [])]
    for (const carrier of carriers) {
      const label = fields?.[carrier.key]
      if (typeof label !== 'string' || label.length === 0) missing.push(`${entity.key}: ${carrier.key}`)
    }
  }
  assert.deepEqual(missing, [])
})
