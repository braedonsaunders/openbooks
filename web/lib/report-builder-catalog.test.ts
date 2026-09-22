import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { HRM_REPORT_ENTITIES, REPORT_ENTITIES, REPORT_ENTITY_MAP } from '@openbooks/reports'
import { availableReportEntities, reportColumnGroup } from './report-builder-catalog'

test('the builder source list includes every governed HR source unless the server hides it', () => {
  const hidden = HRM_REPORT_ENTITIES[0]!.key
  const visible = availableReportEntities(REPORT_ENTITIES, [hidden])
  const visibleKeys = new Set(visible.map((entity) => entity.key))

  assert.equal(visibleKeys.has(hidden), false)
  for (const entity of HRM_REPORT_ENTITIES.slice(1)) {
    assert.equal(visibleKeys.has(entity.key), true, `${entity.key} is absent from the builder source list`)
  }
})

test('the column browser exposes base, joined, and identifier fields as distinct groups', () => {
  const ledger = REPORT_ENTITY_MAP.ledger_lines!
  assert.equal(reportColumnGroup(ledger, ledger.columns.find((column) => column.key === 'quantity')!), 'record')
  assert.equal(reportColumnGroup(ledger, ledger.columns.find((column) => column.key === 'party_name')!), 'related')
  assert.equal(reportColumnGroup(ledger, ledger.columns.find((column) => column.key === 'party_id')!), 'identifiers')
})
