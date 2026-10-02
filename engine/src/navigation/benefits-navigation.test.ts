import assert from 'node:assert/strict'
import test from 'node:test'
import { HRM_LOCAL_NAVIGATION, LOCAL_NAVIGATION, applyLocalNavigationPreferences } from './local-navigation.ts'
import { reconcileNavConfig } from './nav-config.ts'
import { defaultNavConfig, NAV_MODULES } from './nav-registry.ts'

test('Benefits owns programs, enrollment, rewards and incentives while compensation retains its own workspace', () => {
  const benefits = LOCAL_NAVIGATION.find((workspace) => workspace.id === 'hrm-rewards')!
  assert.equal(benefits.label, 'Benefits')
  assert.equal(benefits.tabs[0]?.href, '/hrm/benefits')
  for (const view of ['programs', 'enrolments', 'rewards', 'incentives', 'policies', 'payouts']) {
    const tab = benefits.tabs.find((candidate) => candidate.href === `/hrm/benefits?view=${view}`)
    assert.ok(tab, view)
    assert.equal(tab.permission, 'hrm.benefits.read'); assert.equal(NAV_MODULES.find(module => module.href === tab.href)?.featureKey, 'hrm')
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


test('Enrollment windows have no independent registered page or main-menu destination', () => {
  const config = reconcileNavConfig(defaultNavConfig())
  assert.ok(!NAV_MODULES.some((module) => module.key === 'hrm-benefits-windows' || module.href === '/hrm/benefits?view=windows'))
  assert.ok(!config.groups.flatMap((group) => group.items).some((item) => item.kind === 'module' && item.moduleKey === 'hrm-benefits-windows'))
  assert.ok(!HRM_LOCAL_NAVIGATION.rewards.some((tab) => tab.href === '/hrm/benefits?view=windows'))
  assert.ok(NAV_MODULES.some((module) => module.href === '/hrm/benefits?view=enrolments'))
})
