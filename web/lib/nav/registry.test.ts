import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_NAV_ORDER,
  NAV_GROUPS,
  NAV_MODULES,
  defaultNavConfig,
  layerInNavApps,
  type OrgNavConfig,
} from './registry'

test('default navigation is a complete version-two workspace configuration', () => {
  const config = defaultNavConfig()
  assert.equal(config.version, 2)
  assert.deepEqual(
    config.groups.map((group) => group.id),
    NAV_GROUPS.map((group) => group.key),
  )
  assert.deepEqual(
    config.groups.flatMap((group) => group.items).map((item) => (item.kind === 'module' ? item.moduleKey : '')),
    NAV_GROUPS.flatMap((group) => DEFAULT_NAV_ORDER[group.key]),
  )
})

test('default workspaces follow the approved journey-oriented information architecture', () => {
  assert.deepEqual(
    NAV_GROUPS.map((group) => [group.key, group.label]),
    [
      ['my-work', 'My Work'],
      ['customers', 'Customers'],
      ['purchasing', 'Purchasing'],
      ['operations', 'Operations'],
      ['banking', 'Banking'],
      ['accounting', 'Accounting'],
      ['insights', 'Insights'],
      ['settings', 'Settings'],
    ],
  )
  assert.deepEqual(DEFAULT_NAV_ORDER.customers, [
    'customers',
    'crm-leads',
    'crm-prospects',
    'crm-activities',
    'crm-opportunities',
    'crm-forecasts',
    'estimates',
    'sales-orders',
    'ar',
    'collections',
    'ar-invoices',
    'receipts',
  ])
  assert.deepEqual(DEFAULT_NAV_ORDER.operations, [
    'projects',
    'timesheets',
    'field-tickets',
    'items',
    'inventory',
    'equipment',
    'employees',
  ])
  assert.deepEqual(
    DEFAULT_NAV_ORDER.accounting.slice(2, 5),
    ['revenue', 'assets', 'tax-depreciation'],
  )
  assert.deepEqual(
    NAV_MODULES.find((module) => module.key === 'tax-depreciation'),
    {
      key: 'tax-depreciation',
      href: '/assets?tab=tax-depreciation',
      label: 'Tax Depreciation',
      iconKey: 'journal',
      group: 'accounting',
      subgroup: 'assets',
      requiredPermission: 'assets.read',
    },
  )
})

test('default mobile navigation pins exactly four high-frequency destinations', () => {
  const pinned = defaultNavConfig()
    .groups.flatMap((group) => group.items)
    .filter((item) => item.mobile)
    .map((item) => (item.kind === 'module' ? item.moduleKey : ''))
  assert.deepEqual(pinned, ['dashboard', 'approvals', 'ar', 'ap'])
})

test('applications for payment is not exposed as a top-level navigation module', () => {
  assert.equal(NAV_MODULES.some((candidate) => candidate.key === 'construction-billing'), false)
})

test('nav-enabled apps layer into My Work once and preserve explicit placement', () => {
  const apps = [{ key: 'expense-insights', name: 'Expense Insights', iconKey: 'activity', showInNav: true }]
  const layered = layerInNavApps(defaultNavConfig(), apps)
  const appItems = layered.groups.flatMap((group) => group.items).filter((item) => item.kind === 'app')
  assert.deepEqual(appItems, [{ kind: 'app', appKey: 'expense-insights' }])

  const moved: OrgNavConfig = {
    ...layered,
    groups: layered.groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.kind !== 'app') as typeof group.items,
    })),
  }
  moved.groups.find((group) => group.id === 'insights')!.items.push(appItems[0]!)
  assert.equal(layerInNavApps(moved, apps), moved)
})

test('every module belongs to a declared workspace and has a unique stable key', () => {
  const groupKeys = new Set(NAV_GROUPS.map((group) => group.key))
  const moduleKeys = NAV_MODULES.map((module) => module.key)
  const orderedKeys = NAV_GROUPS.flatMap((group) => DEFAULT_NAV_ORDER[group.key])
  assert.equal(new Set(moduleKeys).size, NAV_MODULES.length)
  assert.deepEqual([...orderedKeys].sort(), [...moduleKeys].sort())
  for (const module of NAV_MODULES) assert.ok(groupKeys.has(module.group), module.key)
  for (const group of NAV_GROUPS) {
    for (const moduleKey of DEFAULT_NAV_ORDER[group.key]) {
      assert.equal(NAV_MODULES.find((module) => module.key === moduleKey)?.group, group.key, moduleKey)
    }
  }
})
