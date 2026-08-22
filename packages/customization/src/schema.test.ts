import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultListView,
  defaultFormLayout,
  lintFormLayout,
  mergeRegisteredFieldsIntoLayout,
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
  assert.deepEqual(meta.listColumns.slice(0, 6).map((column) => column.key), [
    'asset_number',
    'name',
    'category_name',
    'acquisition_cost',
    'accumulated',
    'net_book_value',
  ])
  assert.deepEqual(meta.listFilters.map((filter) => filter.key), [
    'status',
    'category_id',
    'acquired_on',
    'serial_number',
  ])
  assert.deepEqual(lintFormLayout(layout), [])
})

test('properties expose system form, operational tabs, and default list view', () => {
  const meta = getRecordType('property')
  assert.ok(meta)
  assert.equal(meta.supportsForms, true)
  assert.equal(meta.customFieldTable, 'managed_properties')

  const layout = defaultFormLayout('property')
  assert.deepEqual(resolveFormTabs(layout).map((tab) => tab.key), [
    'overview',
    'units',
    'leases',
    'rent',
    'deposits',
    'cam',
  ])
  assert.deepEqual(lintFormLayout(layout), [])
  assert.equal(
    layout.header.groups[0]!.fields.some((field) => field.key === 'deposit_liability_account_id'),
    true,
  )

  const view = defaultListView('property')
  assert.deepEqual(
    view.columns.filter((column) => column.visible).map((column) => column.key),
    ['name', 'code', 'subsidiary', 'location', 'property_type', 'occupancy', 'status'],
  )
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

test('opportunity list customization exposes pipeline columns and filters without a form designer', () => {
  const opportunity = getRecordType('opportunity')!

  assert.equal(opportunity.supportsForms, false)
  assert.equal(opportunity.customFieldTable, 'crm_opportunities')
  assert.deepEqual(opportunity.listColumns.slice(0, 7).map((column) => column.key), [
    'opportunity_number',
    'title',
    'account_name',
    'status',
    'owner_name',
    'expected_close_date',
    'projected_amount',
  ])
  assert.deepEqual(opportunity.listFilters.slice(0, 3).map((filter) => filter.key), [
    'status_id',
    'owner_user_id',
    'forecast_category',
  ])
  assert.equal(defaultListView('opportunity').sort?.column, 'expected_close_date')
})

test('bank workflow lists expose saved-view contracts without form designers', () => {
  const reconciliation = getRecordType('bank_reconciliation')!
  const statement = getRecordType('bank_statement')!
  const rule = getRecordType('bank_rule')!

  for (const meta of [reconciliation, statement, rule]) {
    assert.equal(meta.supportsForms, false)
    assert.ok(defaultListView(meta.key).columns.length > 0)
  }
  assert.deepEqual(reconciliation.listFilters.map((filter) => filter.key), ['status', 'account_id', 'through_date'])
  assert.deepEqual(statement.listFilters.map((filter) => filter.key), ['source', 'account_id', 'statement_date'])
  assert.deepEqual(rule.listFilters.map((filter) => filter.key), ['is_active'])
})

test('saved forms gain newly registered built-in fields in registry order', () => {
  const layout = defaultFormLayout('project')
  layout.header.groups[0]!.fields = layout.header.groups[0]!.fields.filter((field) => field.key !== 'project_type_id')

  mergeRegisteredFieldsIntoLayout(layout)

  const fields = layout.header.groups[0]!.fields
  const projectTypeIndex = fields.findIndex((field) => field.key === 'project_type_id')
  assert.equal(projectTypeIndex, fields.findIndex((field) => field.key === 'code') + 1)
  assert.equal(fields[projectTypeIndex]!.colSpan, 2)
  assert.deepEqual(lintFormLayout(layout), [])
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

test('the project cockpit ships a customizable tab list', () => {
  const layout = defaultFormLayout('project')

  assert.deepEqual(layout.tabs?.map((tab) => tab.key), [
    'overview',
    'financials',
    'project_management',
    'cost_time',
    'billing',
    'transactions',
  ])
  assert.deepEqual(
    layout.tabs?.find((tab) => tab.key === 'project_management')?.subtabs?.map((tab) => tab.key),
    ['work_breakdown', 'schedule'],
  )
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
    {
      key: 'project_management',
      visible: true,
      subtabs: [{ key: 'work_breakdown', visible: false, labelOverride: 'Scope' }],
    },
    { key: 'retired_tab', visible: true },
    { key: 'tab_safety', visible: true, groupIds: ['primary'] },
  ]

  const resolved = resolveFormTabs(layout)

  // Chosen order is preserved, the unknown tab is dropped, the author's own tab
  // survives, and every tab the registry has since added is appended.
  assert.deepEqual(resolved.map((tab) => tab.key), [
    'billing',
    'overview',
    'project_management',
    'tab_safety',
    'financials',
    'cost_time',
    'transactions',
  ])
  const management = resolved.find((tab) => tab.key === 'project_management')
  assert.equal(management?.visible, true)
  assert.equal(management?.subtabs?.find((tab) => tab.key === 'work_breakdown')?.visible, false)
  assert.equal(management?.subtabs?.find((tab) => tab.key === 'work_breakdown')?.labelOverride, 'Scope')
  assert.equal(management?.subtabs?.find((tab) => tab.key === 'schedule')?.visible, true)
})

test('the default project cockpit puts financials immediately after overview', () => {
  assert.deepEqual(
    defaultFormLayout('project').tabs?.slice(0, 2).map((tab) => tab.key),
    ['overview', 'financials'],
  )
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

test('optional-module record types declare a Features switch', () => {
  const expected: Record<string, string> = {
    quote: 'orders',
    sales_order: 'orders',
    purchase_order: 'orders',
    expense_report: 'expenses',
    project_charge: 'projects',
    project: 'projects',
    labor_rate_card: 'projects',
    field_ticket: 'fieldTickets',
    opportunity: 'crm',
    lead: 'crm',
    prospect: 'crm',
    activity: 'crm',
    inventory_onhand: 'inventory',
    inventory_movement: 'inventory',
    budget_scenario: 'budgets',
    revenue_contract: 'revenueRecognition',
    equipment_unit: 'equipment',
    timesheet_week: 'timeTracking',
    fixed_asset: 'fixedAssets',
    property: 'propertyManagement',
    pay_run: 'payroll',
  }
  for (const [key, feature] of Object.entries(expected)) {
    assert.equal(getRecordType(key)?.featureKey, feature, key)
  }
  // Core catalog and intentional exceptions: items without inventory,
  // banking vs bankFeeds.
  for (const key of ['item', 'vendor_bill', 'customer', 'bank_transaction', 'bank_reconciliation', 'bank_statement', 'bank_rule', 'journal', 'account']) {
    assert.equal(getRecordType(key)?.featureKey, undefined, key)
  }
})
