import assert from 'node:assert/strict'
import test from 'node:test'
import { getRecordType } from '@openbooks/customization'


test('project charges are first-class customizable transactions, not a parallel project tab', () => {
  const project = getRecordType('project')
  const charge = getRecordType('project_charge')

  assert.ok(project)
  assert.equal(project.tabs?.some((tab) => tab.key === 'charges'), false)
  assert.ok(charge)
  assert.equal(charge.category, 'transaction')
  assert.deepEqual(
    charge.lineFields.map((field) => field.key),
    ['item_id', 'description', 'quantity', 'unit', 'cost_rate', 'amount', 'bill_rate', 'bill_amount', 'is_billable', 'project_id'],
  )
})
