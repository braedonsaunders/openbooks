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

const { allocationsSpec } = (await import('./view.ts')) as typeof import('./view.ts')
hooks.deregister()

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
  test(`spec always mounts the header strip and the ${tab} body widget`, () => {
    const names = widgetNames(allocationsSpec(data(tab)))
    assert.deepEqual(names, [
      'allocations-setup-header',
      'allocations-rules-tab',
      'allocations-drivers-tab',
      'allocations-runs-tab',
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
