import test from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultListView,
  defaultFormLayout,
  lintListView,
  lintFormLayout,
  mergeRegisteredFieldsIntoLayout,
  resolveFormTabs,
} from './schema.ts'
import { getRecordType, recordTypeForFeatureState } from './registry.ts'

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

test('customer list customization spans the whole relationship lifecycle', () => {
  // One account list, three stages. `lead` belongs here because the retired
  // /crm/leads page's rows now arrive on this list — see customerBaseJoins.
  const customer = getRecordType('customer')!
  const status = customer.listFilters.find((filter) => filter.key === 'status')

  assert.deepEqual(status?.options?.map((option) => option.value), ['customer', 'prospect', 'lead'])
  assert.equal(status?.labelKey, 'crm.fields.lifecycleStage')
  assert.equal(customer.listColumns.find((column) => column.key === 'status')?.sortable, true)
  assert.equal(customer.listColumns.find((column) => column.key === 'status')?.labelKey, 'crm.fields.stage')
  assert.deepEqual(customer.listColumns.map((column) => column.key), [
    'display_name',
    'short_code',
    'email',
    'phone',
    'status',
    'crm_status',
    'owner_name',
    'territory_name',
    'qualification_score',
    'last_activity',
  ])
  // A→Z by name, declared rather than inferred: the inferred fallback pairs a
  // seeded view's stale direction with whatever column survives (F: customers
  // listed Z→A).
  assert.deepEqual(customer.defaultSort, { sortKey: 'name', dir: 'asc' })
  assert.deepEqual(defaultListView('customer').sort, { column: 'display_name', dir: 'asc' })
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

test('item list-filter options drop inventory kinds when Inventory is off', () => {
  const item = getRecordType('item')
  assert.ok(item)
  const hidden = recordTypeForFeatureState(item, { inventory: false })
    .listFilters.find((filter) => filter.key === 'kind')?.options?.map((option) => option.value) ?? []
  assert.deepEqual(hidden.filter((value) => ['inventory', 'assembly', 'kit'].includes(value)), [])
  const shown = recordTypeForFeatureState(item, { inventory: true })
    .listFilters.find((filter) => filter.key === 'kind')?.options?.map((option) => option.value) ?? []
  assert.ok(shown.includes('inventory') && shown.includes('assembly') && shown.includes('kit'))
})

test('the customer list collapses to customers when CRM is off', () => {
  // Off, this is the AR customer roll and nothing else: no other lifecycle
  // option, and no column or filter reading the crm_account_profiles joins
  // that customerBaseJoins(false) never makes.
  const customer = getRecordType('customer')
  assert.ok(customer)
  const off = recordTypeForFeatureState(customer, { inventory: true, crm: false })
  assert.deepEqual(
    off.listFilters.find((filter) => filter.key === 'status')?.options?.map((option) => option.value),
    ['customer'],
  )
  assert.equal(off.listFilters.find((filter) => filter.key === 'status')?.labelKey, 'common.labels.status')
  assert.equal(off.listColumns.find((column) => column.key === 'status')?.labelKey, 'common.labels.status')
  assert.deepEqual(off.listColumns.map((column) => column.key), [
    'display_name',
    'short_code',
    'email',
    'phone',
    'status',
  ])
  assert.deepEqual(off.listFilters.map((filter) => filter.key), ['status'])

  const on = recordTypeForFeatureState(customer, { inventory: true, crm: true })
  assert.deepEqual(
    on.listFilters.find((filter) => filter.key === 'status')?.options?.map((option) => option.value),
    ['customer', 'prospect', 'lead'],
  )
  assert.deepEqual(on.listFilters.map((filter) => filter.key), ['status', 'status_id', 'owner_user_id', 'territory_id'])
})

test('the employee list gains directory columns with HRM on and drops them with HRM off', () => {
  // HR-2b: the roster carries department, job title, employment status,
  // employer subsidiary and service start while HRM is on; HRM off, it is
  // the party roster and nothing else — filters and columns absent, not
  // empty. Untouched org defaults pick the columns up through
  // mergeCustomFieldsIntoView, which appends missing registry columns.
  const employee = getRecordType('employee')
  assert.ok(employee)
  const off = recordTypeForFeatureState(employee, { inventory: true, hrm: false })
  assert.deepEqual(off.listColumns.map((column) => column.key), [
    'display_name',
    'short_code',
    'email',
    'phone',
    'status',
  ])
  assert.deepEqual(off.listFilters.map((filter) => filter.key), [])

  const on = recordTypeForFeatureState(employee, { inventory: true, hrm: true })
  assert.deepEqual(on.listColumns.map((column) => column.key), [
    'display_name',
    'short_code',
    'email',
    'phone',
    'department',
    'job_title',
    'employment_status',
    'employer',
    'service_start',
    'status',
  ])
  assert.deepEqual(on.listFilters.map((filter) => filter.key), ['department', 'employment_status', 'employer'])
  for (const column of on.listColumns.filter((c) => ['department', 'job_title', 'employment_status', 'employer', 'service_start'].includes(c.key))) {
    assert.ok(column.labelKey && column.labelKey.includes('.'), `${column.key} resolves its label through the catalogs`)
    assert.ok(column.sortable && column.sortKey, `${column.key} is sortable through a whitelisted sort key`)
  }
  assert.deepEqual(defaultListView('employee').sort, { column: 'display_name', dir: 'asc' })
  const visible = defaultListView('employee').columns.filter((c) => c.visible).map((c) => c.key)
  for (const key of ['department', 'job_title', 'employment_status', 'employer', 'service_start']) {
    assert.ok(visible.includes(key), `the seeded default view carries ${key}`)
  }
})

test('journal origin filter offers migration alongside the posting origins (F-t12-014)', () => {
  // Migration true-ups are GL-native journals visible with Origin=All, so
  // the Origin dropdown must offer Migration as an explicit choice too.
  const journal = getRecordType('journal')
  assert.ok(journal)
  const origins = journal.listFilters.find((filter) => filter.key === 'origin')?.options?.map((option) => option.value) ?? []
  assert.ok(origins.includes('migration'), `origin options hide migration: ${origins.join(',')}`)
})

test('between list filters require both bounds', () => {
  const view = defaultListView('vendor_bill')
  view.filters = [{ key: 'document_date', operator: 'between', to: '2026-12-31' }]

  assert.deepEqual(lintListView(view), [
    {
      path: 'filters[0]',
      message: 'filter "document_date" needs a value',
    },
  ])

  view.filters[0]!.value = '2026-01-01'
  assert.deepEqual(lintListView(view), [])
})

test('the default check form carries an optional vendor payee', () => {
  // F-t05-008: the standalone check form had no payee field although the
  // record model (doc.party_id) and the posting rule both support one. The
  // payee stays optional — anonymous expense checks remain valid.
  const check = getRecordType('check')
  assert.ok(check)
  const party = check.headerFields.find((field) => field.key === 'party_id')
  assert.deepEqual(party, {
    key: 'party_id',
    labelKey: 'common.labels.vendor',
    level: 'header',
    kind: 'entity_ref',
  })
  const layout = defaultFormLayout('check')
  const keys = layout.header.groups.flatMap((group) => group.fields.map((field) => field.key))
  assert.ok(keys.includes('party_id'))
  assert.deepEqual(lintFormLayout(layout), [])
})
