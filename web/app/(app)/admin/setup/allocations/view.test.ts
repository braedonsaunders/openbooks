import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return { url: 'mock:alloc-setup-intl', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:alloc-setup-intl') {
      return {
        format: 'module',
        source: `export async function getTranslations(namespace) { return (key, vars) => vars ? namespace + ':' + key + ':' + JSON.stringify(vars) : namespace + ':' + key; }`,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const hooks2 = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/lib/authz')) {
      return { shortCircuit: true, format: 'module', url: 'mock:alloc-setup-authz' }
    }
    if (specifier.endsWith('/lib/feature-gates')) {
      return { shortCircuit: true, format: 'module', url: 'mock:alloc-setup-features' }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, format: 'module', url: 'mock:alloc-setup-nav' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:alloc-setup-authz') {
      return {
        format: 'module',
        source: `export async function getAuthz() { return globalThis.__allocAuthz ?? null; }
          export function can(authz, perm) { return authz?.perms?.includes(perm) ?? false; }
          export async function requirePermission() { throw new Error('STALE_REQUIRE_PERMISSION'); }`,
        shortCircuit: true,
      }
    }
    if (url === 'mock:alloc-setup-features') {
      return {
        format: 'module',
        source: `export async function requireFeatureEnabled() { if (globalThis.__allocFeatureOff) throw new Error('NOT_FOUND'); }`,
        shortCircuit: true,
      }
    }
    if (url === 'mock:alloc-setup-nav') {
      return {
        format: 'module',
        source: `export function redirect(url) { throw new Error('REDIRECT:' + url); }`,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const { allocationsSpec, loadAllocations } = (await import('./view.ts')) as typeof import('./view.ts')
hooks.deregister()
hooks2.deregister()

import type { AllocationsSetupData } from './view.ts'

function data(tab: AllocationsSetupData['tab']): AllocationsSetupData {
  return {
    tab,
    onRules: tab === 'rules',
    onDrivers: tab === 'drivers',
    onRuns: tab === 'runs',
    title: 'Allocations',
    description: 'Distribute pooled costs.',
    tabsAria: 'Allocation setup sections',
    tabs: (['rules', 'drivers', 'runs'] as const).map((key) => ({
      key,
      href: `/admin/setup/allocations?tab=${key}`,
      label: key,
      active: key === tab,
    })),
    currentParams: { tab },
  }
}

/** Walk the spec JSON for widget names in render order. */
function widgetNames(spec: unknown): string[] {
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>
      if (typeof record['widget'] === 'string') found.push(record['widget'])
      for (const value of Object.values(record)) visit(value)
    }
  }
  visit(spec)
  return found
}

for (const tab of ['rules', 'drivers', 'runs'] as const) {
  test(`spec always mounts the header strip, the ${tab} body widget and the rule drawer`, () => {
    const names = widgetNames(allocationsSpec(data(tab)))
    assert.deepEqual(names, [
      'allocations-setup-header',
      'allocations-rules-tab',
      'allocations-drivers-tab',
      'allocations-runs-tab',
      'allocations-rule-drawer',
    ])
  })
}

test('spec carries the tab conditions (exactly one body renders per request)', () => {
  const serialized = JSON.stringify(allocationsSpec(data('drivers')))
  assert.match(serialized, /onRules/)
  assert.match(serialized, /onDrivers/)
  assert.match(serialized, /onRuns/)
})

test('header block carries title, tabs and the tab-strip aria label', () => {
  const spec = JSON.parse(JSON.stringify(allocationsSpec(data('runs')))) as {
    body: { blocks: { widget: string; props: Record<string, unknown> }[] }[]
  }
  const header = spec.body.flatMap((section) => section.blocks).find((b) => b.widget === 'allocations-setup-header')
  assert.ok(header, 'header widget must be present')
  assert.equal(header.props['title'], 'Allocations')
  assert.equal(header.props['tabsAria'], 'Allocation setup sections')
  const tabs = header.props['tabs'] as { key: string; active: boolean }[]
  assert.deepEqual(tabs.map((item) => [item.key, item.active]), [
    ['rules', false],
    ['drivers', false],
    ['runs', true],
  ])
})

/** Shell gate mirrors the setup layout: login, then admin.setup.manage OR crm.setup.manage. */
async function loadWith(authz: unknown, featureOff = false): Promise<AllocationsSetupData> {
  ;(globalThis as Record<string, unknown>).__allocAuthz = authz
  ;(globalThis as Record<string, unknown>).__allocFeatureOff = featureOff
  try {
    return await loadAllocations({ tab: 'drivers' })
  } finally {
    ;(globalThis as Record<string, unknown>).__allocAuthz = null
    ;(globalThis as Record<string, unknown>).__allocFeatureOff = false
  }
}

test('shell without a session redirects to login', async () => {
  await assert.rejects(loadWith(null), /REDIRECT:\/login/)
})

test('shell without either setup permission names the refusal (F1T-10)', async () => {
  await assert.rejects(
    loadWith({ user: { orgId: 'o1' }, perms: ['ap.create'] }),
    /REDIRECT:\/access-denied\?permission=admin\.setup\.manage/,
  )
})

test('shell admits the layout CRM-setup alternative (parity with SetupLayout)', async () => {
  const data = await loadWith({ user: { orgId: 'o1' }, perms: ['crm.setup.manage'] })
  assert.equal(data.tab, 'drivers')
})

test('shell admits the admin setup permission', async () => {
  const data = await loadWith({ user: { orgId: 'o1' }, perms: ['admin.setup.manage'] })
  assert.equal(data.tab, 'drivers')
})

test('shell surfaces feature-off as not-found (the Setup precedent)', async () => {
  await assert.rejects(loadWith({ user: { orgId: 'o1' }, perms: ['admin.setup.manage'] }, true), /NOT_FOUND/)
})

test('unknown tabs fall back to Rules', async () => {
  ;(globalThis as Record<string, unknown>).__allocAuthz = { user: { orgId: 'o1' }, perms: ['admin.setup.manage'] }
  try {
    const data = await loadAllocations({ tab: 'nope' })
    assert.equal(data.tab, 'rules')
    assert.ok(data.onRules)
  } finally {
    ;(globalThis as Record<string, unknown>).__allocAuthz = null
  }
})
