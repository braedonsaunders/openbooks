import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultNavConfig, NAV_MODULES, type OrgNavConfig } from './nav-registry.ts'
import { reconcileNavConfig, featureAwareNavConfig } from './nav-config.ts'
import { applyLocalNavigationPreferences } from './local-navigation.ts'

test('legacy default people destinations move without losing settings or mutating stored data', () => {
  const saved: OrgNavConfig = { version: 2, groups: [{ id: 'operations', label: 'Operations', items: [
    { kind: 'module', moduleKey: 'employees', mobile: true, hidden: true },
    { kind: 'module', moduleKey: 'payroll', label: 'Payroll' },
    { kind: 'module', moduleKey: 'hrm' }, { kind: 'module', moduleKey: 'me' },
  ] }] }
  const before = structuredClone(saved)
  const result = reconcileNavConfig(saved)
  assert.deepEqual(saved, before)
  const people = result.groups.find((group) => group.id === 'hrm')!
  assert.equal(people.label, 'People')
  const employee = people.items.find((item) => item.kind === 'module' && item.moduleKey === 'employees')!
  assert.equal(employee.hidden, true)
  assert.equal(employee.mobile, true)
  assert.ok(result.groups.find((group) => group.id === 'my-work')!.items.some((item) => item.kind === 'module' && item.moduleKey === 'me'))
  assert.deepEqual(reconcileNavConfig(result), result, 'reconciliation is idempotent')
  const keys = result.groups.flatMap((group) => group.items.flatMap((item) => item.kind === 'module' ? [item.moduleKey] : []))
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, NAV_MODULES.length)
})

test('deliberate placements, labels, links, and local preferences survive new defaults', () => {
  const saved: OrgNavConfig = { version: 2, groups: [{ id: 'custom', label: 'Our team', items: [
    { kind: 'module', moduleKey: 'employees', placement: 'custom', label: 'Team directory' },
    { kind: 'link', href: 'https://example.com', label: 'Portal' },
  ] }], localNavigation: { payroll: { items: [{ href: '/payroll/runs', hidden: true }] } } }
  const result = reconcileNavConfig(saved)
  assert.deepEqual(result.groups[0], saved.groups[0])
  assert.deepEqual(result.localNavigation, saved.localNavigation)
  assert.equal(result.groups.flatMap((group) => group.items).filter((item) => item.kind === 'module' && item.moduleKey === 'employees').length, 1)
})

test('HR promotion and its disabled fallback preserve independent payroll ownership', () => {
  const config = defaultNavConfig()
  const before = structuredClone(config)
  const enabled = featureAwareNavConfig(config, true)
  assert.ok(enabled.groups.find((group) => group.id === 'hrm')!.items.some((item) => item.kind === 'module' && item.moduleKey === 'payroll'))
  const disabled = featureAwareNavConfig(config, false)
  const operations = disabled.groups.find((group) => group.id === 'operations')!.items
  assert.ok(operations.some((item) => item.kind === 'module' && item.moduleKey === 'employees'))
  assert.ok(operations.some((item) => item.kind === 'module' && item.moduleKey === 'payroll'))
  assert.ok(operations.some((item) => item.kind === 'module' && item.moduleKey === 'payroll-runs'))
  assert.ok(!operations.some((item) => item.kind === 'module' && item.moduleKey === 'hrm'))
  assert.deepEqual(config, before)
  assert.deepEqual(featureAwareNavConfig(disabled, false), disabled)
})

test('local order, visibility and names cannot resurrect unavailable choices', () => {
  const tabs = [{ href: '/payroll', label: 'Payroll' }, { href: '/payroll/runs', label: 'Pay runs' }]
  assert.deepEqual(applyLocalNavigationPreferences(tabs, { items: [
    { href: '/payroll/runs', label: 'Process payroll' },
    { href: '/restricted', label: 'Restricted' },
    { href: '/payroll', hidden: true },
    { href: '/payroll/runs', hidden: true },
  ] }), [{ href: '/payroll/runs', label: 'Process payroll' }])
  assert.deepEqual(applyLocalNavigationPreferences([...tabs, { href: '/new', label: 'New' }], { items: [{ href: '/payroll', hidden: true }] }), [tabs[1], { href: '/new', label: 'New' }])
})
