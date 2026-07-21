import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultFormLayout,
  lintFormLayout,
  mergeRegisteredFieldsIntoLayout,
  refreshDefaultFormLayout,
} from './schema.ts'

test('the default project form composes complete four-column rows', () => {
  const layout = defaultFormLayout('project')
  const fields = layout.header.groups[0]!.fields

  assert.deepEqual(fields.map((field) => field.key), [
    'name',
    'code',
    'project_type_id',
    'customer_id',
    'status',
    'billing_method',
    'contract_value',
    'customer_po_number',
    'foreman_id',
    'manager_id',
    'starts_on',
    'ends_on',
    'subsidiary_id',
    'notes',
  ])

  const rowWidths: number[] = []
  let currentWidth = 0
  for (const field of fields) {
    const width = field.colSpan ?? 1
    if (currentWidth + width > 4) {
      rowWidths.push(currentWidth)
      currentWidth = 0
    }
    currentWidth += width
    if (currentWidth === 4) {
      rowWidths.push(currentWidth)
      currentWidth = 0
    }
  }
  if (currentWidth > 0) rowWidths.push(currentWidth)

  assert.deepEqual(rowWidths, [4, 4, 4, 4, 4, 4, 4])
  assert.deepEqual(lintFormLayout(layout), [])
})

test('saved forms gain newly registered built-in fields in registry order', () => {
  const legacy = defaultFormLayout('project')
  legacy.header.groups[0]!.fields = legacy.header.groups[0]!.fields.filter((field) => field.key !== 'project_type_id')

  mergeRegisteredFieldsIntoLayout(legacy)

  const fields = legacy.header.groups[0]!.fields
  const projectTypeIndex = fields.findIndex((field) => field.key === 'project_type_id')
  assert.equal(projectTypeIndex, fields.findIndex((field) => field.key === 'code') + 1)
  assert.equal(fields[projectTypeIndex]!.colSpan, 2)
  assert.deepEqual(lintFormLayout(legacy), [])
})

test('the baseline form upgrade refreshes built-in placement without losing field choices', () => {
  const legacy = defaultFormLayout('project')
  delete legacy.defaultLayoutVersion
  const primary = legacy.header.groups[0]!
  primary.fields = primary.fields.filter((field) => field.key !== 'project_type_id')
  const name = primary.fields.find((field) => field.key === 'name')!
  name.colSpan = 2
  const billing = primary.fields.find((field) => field.key === 'billing_method')!
  billing.visible = false
  billing.labelOverride = 'Billing basis'
  primary.fields.push({ key: 'cf_permit_number', visible: true, colSpan: 2 })

  refreshDefaultFormLayout(legacy)

  const fields = legacy.header.groups[0]!.fields
  assert.equal(legacy.defaultLayoutVersion, 1)
  assert.deepEqual(fields.slice(0, 4).map((field) => field.key), [
    'name',
    'code',
    'project_type_id',
    'customer_id',
  ])
  assert.equal(fields.find((field) => field.key === 'name')!.colSpan, 3)
  assert.equal(fields.find((field) => field.key === 'billing_method')!.visible, false)
  assert.equal(fields.find((field) => field.key === 'billing_method')!.labelOverride, 'Billing basis')
  assert.equal(fields.at(-1)!.key, 'cf_permit_number')
  assert.deepEqual(lintFormLayout(legacy), [])
})
