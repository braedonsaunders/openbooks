import assert from 'node:assert/strict'
import test from 'node:test'
import { itemsWorkspaceTabs } from './tabs'
import type { ItemsData } from './view'

const { itemsSpec } = await import('./view')

function labels() {
  return {
    catalogLabel: 'Catalog',
    rateBooksLabel: 'Rate books',
    familiesLabel: 'Families',
  }
}

test('no gates means no strip: the header renders nothing for a single tab', () => {
  assert.deepEqual(
    itemsWorkspaceTabs({ active: 'catalog', ...labels(), showRateBooks: false, showFamilies: false }),
    [],
  )
})

test('the variants gate adds a Families destination without touching the catalog', () => {
  assert.deepEqual(
    itemsWorkspaceTabs({ active: 'catalog', ...labels(), showRateBooks: false, showFamilies: true }),
    [
      { href: '/items', label: 'Catalog', active: true },
      { href: '/items/families', label: 'Families', active: false },
    ],
  )
})

test('rate books and families share one strip with the current route active', () => {
  assert.deepEqual(
    itemsWorkspaceTabs({ active: 'rate-books', ...labels(), showRateBooks: true, showFamilies: true }).map(
      ({ href, active }) => ({ href, active }),
    ),
    [
      { href: '/items', active: false },
      { href: '/items?view=rate-books', active: true },
      { href: '/items/families', active: false },
    ],
  )
})

test('the family list marks Families active and keeps its way back to the catalog', () => {
  assert.deepEqual(
    itemsWorkspaceTabs({ active: 'families', ...labels(), showRateBooks: false, showFamilies: true }),
    [
      { href: '/items', label: 'Catalog', active: false },
      { href: '/items/families', label: 'Families', active: true },
    ],
  )
})

function widgetsNamed(node: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((item) => widgetsNamed(item, name))
  if (typeof node !== 'object' || node === null) return []
  const object = node as Record<string, unknown>
  const own = object.widget === name ? [object] : []
  return [...own, ...Object.values(object).flatMap((child) => widgetsNamed(child, name))]
}

function catalogFixture(tabs: ItemsData['tabs']): ItemsData {
  return {
    title: 'Items & Services',
    description: 'The catalog',
    canManage: true,
    currentParams: {},
    onRateBooks: false,
    onCatalog: true,
    tabs,
    drawer: null,
  }
}

test('the catalog spec carries the workspace strip into the header actions', () => {
  const tabs = itemsWorkspaceTabs({ active: 'catalog', ...labels(), showRateBooks: false, showFamilies: true })
  const spec = itemsSpec(catalogFixture(tabs))
  const headers = widgetsNamed(spec, 'items-header-actions')
  assert.equal(headers.length, 1, 'the catalog header owns its actions widget')
  assert.deepEqual((headers[0]?.props as { tabs?: unknown })?.tabs, tabs)
})
