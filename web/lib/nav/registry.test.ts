import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_NAV_ORDER,
  NAV_GROUPS,
  NAV_MODULES,
  defaultNavConfig,
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
    'property-management',
    'projects',
    'wip-billing',
    'timesheets',
    'field-tickets',
    'payroll',
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

test('installed apps are absent from default navigation until explicitly placed', () => {
  const appItems = defaultNavConfig().groups.flatMap((group) => group.items).filter((item) => item.kind === 'app')
  assert.deepEqual(appItems, [])
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

test('native record targets are deterministic data contracts', () => {
  for (const module of NAV_MODULES) {
    const target = module.recordTarget
    if (!target) continue
    assert.ok(module.requiredPermission, `${module.key}: record targets require an authorization boundary`)
    if (target.kind === 'query') {
      assert.match(target.param, /^[a-z][A-Za-z]*$/, module.key)
    } else if (target.kind === 'nested') {
      assert.match(target.segment, /^[a-z][a-z-]*$/, module.key)
    } else {
      assert.equal(module.key, 'projects')
    }
  }
})

test('every module and group carries a translated label', () => {
  // A module added without its `nav.modules` entry renders a raw key in the
  // sidebar and throws MISSING_MESSAGE on the server for every page that
  // resolves the nav — which is every page. The registry and the catalog are
  // edited in different files, so nothing but this connects them.
  const nav = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'messages', 'en', 'nav.json'), 'utf8'),
  ) as { modules: Record<string, string>; groups?: Record<string, string> }

  const missing = NAV_MODULES.filter((module) => !nav.modules[module.key]).map((module) => module.key)
  assert.deepEqual(missing, [], 'these modules have no nav.modules label')

  // The reverse too: a label for a module that no longer exists is dead copy
  // translators keep paying for.
  const keys = new Set(NAV_MODULES.map((module) => module.key))
  const orphaned = Object.keys(nav.modules).filter((key) => !keys.has(key))
  assert.deepEqual(orphaned, [], 'these nav.modules labels name no module')
})
