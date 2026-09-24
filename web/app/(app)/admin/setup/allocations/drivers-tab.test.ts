import assert from 'node:assert/strict'
import test from 'node:test'
import {
  driverConfigFromForm,
  formFromDriver,
  newDriverForm,
} from './driver-form'

// Report-backed drivers name their report and columns: the config carries
// all three trimmed, and edit rehydrates each back into the form.
// Hand-computed against the form shape, never through the drawer.
test('report-definition configs carry the report and both columns', () => {
  const config = driverConfigFromForm({
    ...newDriverForm(),
    sourceKind: 'report_definition',
    reportDefinitionId: 'rep-1',
    dimensionColumn: ' department ',
    valueColumn: ' amount ',
  })
  assert.deepEqual(config, {
    reportDefinitionId: 'rep-1',
    dimensionColumn: 'department',
    valueColumn: 'amount',
  })
})

test('edit rehydrates the report-definition columns', () => {
  const form = formFromDriver({
    key: 'r',
    name: 'R',
    description: null,
    unit: null,
    dimension: 'department',
    sourceKind: 'report_definition',
    isActive: true,
    config: { reportDefinitionId: 'rep-1', dimensionColumn: 'department', valueColumn: 'amount' },
  })
  assert.equal(form.reportDefinitionId, 'rep-1')
  assert.equal(form.dimensionColumn, 'department')
  assert.equal(form.valueColumn, 'amount')
})
