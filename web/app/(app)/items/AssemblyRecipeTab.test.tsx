import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env.ts'
import { stubModules } from '../../../testing/stub-modules.ts'

// QA-056: an assembly without an inventory costing profile gets a Recipe
// tab that names the prerequisite instead of vanishing — the same
// explanation the produced-item picker gives for an empty collection.
await bootJsdomEnvironment({ url: 'http://localhost/items?item=asm-1&itemSetup=recipe' })

stubModules({
  navigation: true,
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next-intl': 'const t = (key) => key; export function useTranslations() { return t } export function useLocale() { return "en" }',
    sonner: 'export const toast = { success() {}, error() {} }',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AssemblyRecipeTab } = await import('./AssemblyRecipeTab.tsx')

const base = {
  itemId: 'asm-1',
  itemLabel: 'ASM-1 · Finished assembly',
  canManage: true,
  tabHref: '/items?item=asm-1&itemSetup=recipe',
  editing: false,
}

test('a profile-less assembly names the costing prerequisite and loads nothing', async () => {
  let fetched = 0
  ;(globalThis as Record<string, unknown>).fetch = (async () => {
    fetched += 1
    return { ok: true, json: async () => ({}) }
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<AssemblyRecipeTab {...base} hasCostingProfile={false} />)
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  try {
    assert.equal(fetched, 0, 'no recipe load without a costing profile')
    assert.ok(
      (host.textContent ?? '').includes('assembly.needsCosting'),
      'the tab must name the missing costing profile',
    )
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('a profiled assembly with no recipe offers to add one', async () => {
  ;(globalThis as Record<string, unknown>).fetch = (async () => ({
    ok: true,
    json: async () => ({ assemblyItemId: 'asm-1', version: null, components: [], validItems: [] }),
  })) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<AssemblyRecipeTab {...base} hasCostingProfile />)
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  try {
    const body = host.textContent ?? ''
    assert.ok(body.includes('assembly.emptyTitle'), 'an empty recipe must say so')
    assert.ok(body.includes('assembly.addRecipe'), 'the operator must be offered the recipe editor')
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})
