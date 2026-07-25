import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultListView,
  defaultFormLayout,
  lintFormLayout,
  mergeRegisteredFieldsIntoLayout,
  refreshDefaultFormLayout,
  resolveFormTabs,
} from './schema.ts'
import { getRecordType } from './registry.ts'

test('the default project form composes complete four-column rows', () => {
  const layout = defaultFormLayout('project')
  const fields = layout.header.groups[0]!.fields

  assert.deepEqual(fields.map((field) => field.key), [
    'name',
    'code',
    'project_type_id',
    'customer_id',
    'status',
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

test('fixed assets expose the universal record form contract', () => {
  const meta = getRecordType('fixed_asset')
  assert.ok(meta)
  assert.equal(meta.supportsForms, true)
  assert.equal(meta.customFieldTable, 'fixed_assets')

  const layout = defaultFormLayout('fixed_asset')
  const keys = layout.header.groups.flatMap((group) => group.fields.map((field) => field.key))
  assert.deepEqual(keys, meta.headerFields.map((field) => field.key))
  assert.equal(keys.includes('depreciation_method'), true)
  assert.equal(keys.includes('depreciation_expense_account_id'), true)
  assert.deepEqual(lintFormLayout(layout), [])
})

test('party role forms expose the complete native record without leaking related-list governance', () => {
  const customer = defaultFormLayout('customer')
  const vendor = defaultFormLayout('vendor')
  const employee = defaultFormLayout('employee')

  assert.deepEqual(lintFormLayout(customer), [])
  assert.deepEqual(lintFormLayout(vendor), [])
  assert.deepEqual(lintFormLayout(employee), [])

  const customerFields = customer.header.groups.flatMap((group) => group.fields)
  assert.equal(customerFields.find((field) => field.key === 'display_name')?.visible, true)
  assert.equal(customerFields.find((field) => field.key === 'labor_pricing')?.colSpan, 4)
  assert.equal(customerFields.find((field) => field.key === 'invoicing_preference')?.colSpan, 4)

  const vendorKeys = vendor.header.groups.flatMap((group) => group.fields.map((field) => field.key))
  assert.equal(vendorKeys.includes('payment_method'), true)
  assert.equal(vendorKeys.includes('ap_account_id'), true)
  assert.equal(vendorKeys.includes('bank_account'), false)

  const employeeKeys = employee.header.groups.flatMap((group) => group.fields.map((field) => field.key))
  assert.equal(employeeKeys.includes('department_id'), true)
  assert.equal(employeeKeys.includes('trade_id'), true)
})

test('customer list customization exposes lifecycle status choices', () => {
  const customer = getRecordType('customer')!
  const status = customer.listFilters.find((filter) => filter.key === 'status')

  assert.deepEqual(status?.options?.map((option) => option.value), ['customer', 'prospect'])
  assert.equal(customer.listColumns.find((column) => column.key === 'status')?.sortable, true)
  assert.deepEqual(defaultListView('customer').columns.map((column) => column.key), [
    'display_name',
    'short_code',
    'email',
    'phone',
    'status',
  ])
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

test('field ticket forms own every details control through the shared form layout', () => {
  const layout = defaultFormLayout('field_ticket')
  const fields = layout.header.groups[0]!.fields

  assert.deepEqual(fields.map((field) => field.key), [
    'project_id',
    'party_id',
    'document_date',
    'period',
    'foreman_party_id',
    'reference_number',
    'memo',
  ])
  assert.equal(fields.find((field) => field.key === 'party_id')?.colSpan, 2)
  assert.equal(fields.find((field) => field.key === 'foreman_party_id')?.colSpan, 2)
  assert.equal(fields.find((field) => field.key === 'memo')?.colSpan, 3)
  assert.deepEqual(lintFormLayout(layout), [])
})

test('the baseline form upgrade refreshes built-in placement without losing field choices', () => {
  const legacy = defaultFormLayout('project')
  delete legacy.defaultLayoutVersion
  const primary = legacy.header.groups[0]!
  primary.fields = primary.fields.filter((field) => field.key !== 'project_type_id')
  const name = primary.fields.find((field) => field.key === 'name')!
  name.colSpan = 2
  const poNumber = primary.fields.find((field) => field.key === 'customer_po_number')!
  poNumber.visible = false
  poNumber.labelOverride = 'PO reference'
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
  assert.equal(fields.find((field) => field.key === 'customer_po_number')!.visible, false)
  assert.equal(fields.find((field) => field.key === 'customer_po_number')!.labelOverride, 'PO reference')
  assert.equal(fields.at(-1)!.key, 'cf_permit_number')
  assert.deepEqual(lintFormLayout(legacy), [])
})

test('the project cockpit ships a customizable tab list', () => {
  const layout = defaultFormLayout('project')

  assert.deepEqual(layout.tabs?.map((tab) => tab.key), [
    'overview',
    'work_breakdown',
    'schedule',
    'financials',
    'cost_time',
    'charges',
    'billing',
    'transactions',
  ])
  assert.equal(
    layout.tabs?.every((tab) => tab.visible),
    true,
  )
})

test('saved tab layouts keep their order, gain new tabs, and drop retired ones', () => {
  const layout = defaultFormLayout('project')
  layout.tabs = [
    { key: 'billing', visible: true },
    { key: 'overview', visible: true },
    { key: 'work_breakdown', visible: false, labelOverride: 'Scope' },
    { key: 'retired_tab', visible: true },
    { key: 'tab_safety', visible: true, groupIds: ['primary'] },
  ]

  const resolved = resolveFormTabs(layout)

  // Chosen order is preserved, the unknown tab is dropped, the author's own tab
  // survives, and every tab the registry has since added is appended.
  assert.deepEqual(resolved.map((tab) => tab.key), [
    'billing',
    'overview',
    'work_breakdown',
    'tab_safety',
    'schedule',
    'financials',
    'cost_time',
    'charges',
    'transactions',
  ])
  assert.equal(resolved.find((tab) => tab.key === 'work_breakdown')?.visible, false)
  assert.equal(resolved.find((tab) => tab.key === 'work_breakdown')?.labelOverride, 'Scope')
})

test('a locked tab can never be hidden or ordered away', () => {
  const layout = defaultFormLayout('project')
  layout.tabs = [{ key: 'overview', visible: false }]

  assert.deepEqual(
    lintFormLayout(layout).map((issue) => issue.message),
    ['overview cannot be hidden'],
  )
  // Even a layout that omits it entirely still renders it.
  layout.tabs = [{ key: 'billing', visible: true }]
  assert.equal(resolveFormTabs(layout)[0]?.key, 'overview')
})

test('tab lint rejects unknown tabs, product-panel groups, and shared groups', () => {
  const layout = defaultFormLayout('project')
  layout.tabs = [
    { key: 'overview', visible: true },
    { key: 'financials', visible: true, groupIds: ['primary'] },
    { key: 'tab_one', visible: true, groupIds: ['primary', 'ghost'] },
    { key: 'tab_two', visible: true, groupIds: ['primary'] },
  ]

  const messages = lintFormLayout(layout).map((issue) => issue.message)

  assert.ok(messages.includes('only custom tabs can host field groups'))
  assert.ok(messages.includes('unknown field group: ghost'))
  assert.ok(messages.includes('field group primary is on more than one tab'))
})
