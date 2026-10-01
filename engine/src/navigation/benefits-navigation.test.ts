import assert from 'node:assert/strict'
import test from 'node:test'
import { HRM_LOCAL_NAVIGATION, LOCAL_NAVIGATION, applyLocalNavigationPreferences } from './local-navigation.ts'
import { isDefaultLocalNavigationItem, reconcileNavConfig } from './nav-config.ts'
import { defaultNavConfig, NAV_MODULES } from './nav-registry.ts'

test('Benefits owns programs, enrollment, rewards and incentives while compensation retains its own workspace', () => {
  const benefits = LOCAL_NAVIGATION.find((workspace) => workspace.id === 'hrm-rewards')!
  assert.equal(benefits.label, 'Benefits')
  assert.equal(benefits.tabs[0]?.href, '/hrm/benefits')
  for (const view of ['programs', 'enrolments', 'windows', 'rewards', 'incentives', 'payouts']) {
    const tab = benefits.tabs.find((candidate) => candidate.href === `/hrm/benefits?view=${view}`)
    assert.ok(tab, view)
    assert.equal(tab.permission, 'hrm.benefits.read')
  }
  assert.ok(!benefits.tabs.some((tab) => tab.href.startsWith('/hrm/compensation')))
  assert.equal(HRM_LOCAL_NAVIGATION.compensation[0]?.href, '/hrm/compensation')
  const hrefs = Object.values(HRM_LOCAL_NAVIGATION).flatMap((tabs) => tabs.map((tab) => tab.href))
  assert.equal(hrefs.length, new Set(hrefs).size)
})

test('new Benefits destinations enter native navigation once and preserve stored preferences', () => {
  const config = defaultNavConfig()
  const placed = config.groups.flatMap((group) => group.items.flatMap((item) => item.kind === 'module' ? [item.moduleKey] : []))
  for (const tab of HRM_LOCAL_NAVIGATION.rewards) {
    const module = NAV_MODULES.find((candidate) => candidate.href === tab.href)!
    assert.ok(module, tab.href)
    assert.equal(placed.filter((key) => key === module.key).length, 1, tab.href)
  }
  const tabs = HRM_LOCAL_NAVIGATION.rewards.map((tab) => ({ ...tab, label: tab.key }))
  const resolved = applyLocalNavigationPreferences(tabs, { items: [{ href: '/hrm/benefits', hidden: true }] })
  assert.ok(!resolved.some((tab) => tab.href === '/hrm/benefits'))
  assert.ok(resolved.some((tab) => tab.href === '/hrm/benefits?view=rewards'))
})


test('enrollment windows remain registered and local while enrollment owns the default main-menu entry', () => {
  const saved = defaultNavConfig()
  const before = structuredClone(saved)
  const reconciled = reconcileNavConfig(saved)
  assert.deepEqual(saved, before, 'saved company preferences are not rewritten')
  const people = reconciled.groups.find((group) => group.id === 'hrm')!
  const windows = people.items.find((item) => item.kind === 'module' && item.moduleKey === 'hrm-benefits-windows')!
  const enrollment = people.items.find((item) => item.kind === 'module' && item.moduleKey === 'hrm-benefits-enrolments')!
  assert.equal(NAV_MODULES.find((module) => module.key === 'hrm-benefits-windows')?.menuParent, 'hrm-benefits-enrolments')
  assert.equal(isDefaultLocalNavigationItem(people.id, windows), true)
  assert.equal(isDefaultLocalNavigationItem(people.id, enrollment), false)
  assert.equal(windows.kind, 'module')
  if (windows.kind !== 'module') throw new Error('Enrollment windows must retain their registered navigation identity')
  assert.equal(isDefaultLocalNavigationItem(people.id, { ...windows, placement: 'custom' }), false, 'explicit shortcuts survive')
  assert.equal(isDefaultLocalNavigationItem('company-shortcuts', windows), false, 'company-defined groups retain shortcuts')
  assert.ok(HRM_LOCAL_NAVIGATION.rewards.some((tab) => tab.href === '/hrm/benefits?view=windows'))
  assert.equal(NAV_MODULES.find((module) => module.key === 'hrm-benefits-windows')?.requiredPermission, 'hrm.benefits.read')
})
