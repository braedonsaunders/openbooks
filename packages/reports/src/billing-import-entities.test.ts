import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { REPORT_ENTITY_MAP } from './entities'
import { BUILT_IN_REPORT_DEFINITIONS } from './built-ins'

test('billing import reconciliation reads the persisted run evidence, gated and unperioded', () => {
  const entity = REPORT_ENTITY_MAP.billing_import_reconciliation
  assert.ok(entity, 'the reconciliation entity is registered')
  assert.equal(entity.featureKey, 'billingHistoryImport')
  assert.equal(entity.requiredPermission, 'sync.run')
  assert.equal(entity.orgColumn, 'recon.org_id')
  assert.equal(entity.defaultPeriodField, null)
  // The three persisted legs of the stored reconciliation each surface rows.
  assert.match(entity.from, /reconciliation -> 'mrr'/)
  assert.match(entity.from, /reconciliation -> 'openAr'/)
  assert.match(entity.from, /reconciliation -> 'differences'/)
  // Runs without stored reconciliation contribute no rows rather than nulls.
  assert.match(entity.from, /r\.reconciliation is not null/)
})

test('billing import reconciliation ships as a Reports-hub built-in', () => {
  const def = BUILT_IN_REPORT_DEFINITIONS.find((d) => d.slug === 'billing-import-reconciliation')
  assert.ok(def, 'the cut-over report is a first-class built-in, not a bespoke screen')
  assert.equal(def.query.entity, 'billing_import_reconciliation')
})
