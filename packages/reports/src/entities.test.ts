import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REPORT_AS_OF, REPORT_ENTITY_MAP, reportEntityForFeatureState } from './entities'

test('items report kind options drop inventory kinds when Inventory is off', () => {
  const items = REPORT_ENTITY_MAP.items
  assert.ok(items)
  const hidden =
    reportEntityForFeatureState(items, { inventory: false }).columns.find((column) => column.key === 'kind')
      ?.options ?? []
  assert.deepEqual(
    hidden.filter((value) => ['inventory', 'assembly', 'kit'].includes(value)),
    [],
  )
  const shown =
    reportEntityForFeatureState(items, { inventory: true }).columns.find((column) => column.key === 'kind')
      ?.options ?? []
  assert.ok(shown.includes('inventory') && shown.includes('assembly') && shown.includes('kit'))
  assert.ok(
    items.columns.find((column) => column.key === 'kind')?.options?.includes('inventory'),
    'the static catalog keeps inventory kinds for existing rows and saved filters',
  )
})

test('entitlement_balances limit as-of is the catalog sentinel, not CURRENT_DATE', () => {
  const from = REPORT_ENTITY_MAP.entitlement_balances!.from
  assert.match(from, new RegExp(REPORT_AS_OF))
  assert.doesNotMatch(from, /CURRENT_DATE/)
})
