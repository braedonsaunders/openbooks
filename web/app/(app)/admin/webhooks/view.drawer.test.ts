import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../../../testing/stub-modules'

stubModules({
  navigation: {
    source: 'export function redirect(path){throw new Error(`redirect:${path}`)}',
  },
  intl: 'export async function getLocale(){return "en"}export async function getTranslations(namespace){const t=(key)=>key;t.has=()=>false;return t}',
})

const { webhooksSpec } = await import('./view')
import type { WebhooksData } from './view'

const base: WebhooksData = {
  title: 'Webhooks',
  description: 'Subscriber endpoints',
  canManage: true,
  currentParams: {},
  emptyTitle: 'No endpoints yet',
  emptyDescription: 'Add your first endpoint',
  drawer: null,
}

function drawerWidgets(data: WebhooksData): unknown[] {
  const found: unknown[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry)
      return
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>
      if (record['widget'] === 'webhook-endpoint-drawer') found.push(node)
      for (const value of Object.values(record)) walk(value)
    }
  }
  walk(webhooksSpec(data))
  return found
}

test('creating an endpoint renders exactly one drawer shell', () => {
  // The loader's drawer entry already covers creation with a null endpoint;
  // a second create entry rendered an identical twin dialog beside it.
  const creating: WebhooksData = {
    ...base,
    drawer: { endpoint: null, closeHref: '/admin/webhooks', canManage: true, eventTypes: ['orders/create'] },
  }
  assert.equal(drawerWidgets(creating).length, 1)
})

test('an open endpoint renders exactly one drawer shell', () => {
  const open: WebhooksData = {
    ...base,
    drawer: { endpoint: { id: 'ep-1' }, closeHref: '/admin/webhooks', canManage: true, eventTypes: [] } as unknown as WebhooksData['drawer'],
  }
  assert.equal(drawerWidgets(open).length, 1)
})

test('no drawer parameter renders no drawer shell', () => {
  assert.equal(drawerWidgets(base).length, 0)
})
