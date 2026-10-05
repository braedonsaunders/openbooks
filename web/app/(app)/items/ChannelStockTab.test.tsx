import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/items?item=kit-1&itemSetup=channels' })

stubModules({
  navigation: {
    source:
      'export function useRouter() { return { push() {}, replace() {}, refresh() {}, back() {} } }' +
      'export function usePathname() { return "/items" }' +
      'export function useSearchParams() { return new URLSearchParams("item=kit-1&itemSetup=channels") }',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next-intl': 'const t = (key) => key; export function useTranslations() { return t } export function useLocale() { return "en" }',
  },
})

const React = await import('react')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ChannelStockTab } = await import('./ChannelStockTab.tsx')

const rows = [
  {
    channelId: 'ch-1', channelName: 'Shopify', externalLocationId: 'loc-1', externalName: 'Main',
    stockLocationCode: 'HQ', available: '10', bufferQuantity: '2', stopSellingAtZero: false,
    sellable: 8, availabilityError: null, lastPushedQuantity: 8, lastShopifyQuantity: 8,
    lastPushedAt: '2026-09-01', lastStatus: 'ok', conflict: null,
  },
  {
    channelId: 'ch-1', channelName: 'Shopify', externalLocationId: 'loc-2', externalName: 'Spare',
    stockLocationCode: 'WH', available: '0', bufferQuantity: '0', stopSellingAtZero: true,
    sellable: 0, availabilityError: 'unmeasurable', lastPushedQuantity: null, lastShopifyQuantity: null,
    lastPushedAt: null, lastStatus: 'error', conflict: { openbooksQuantity: 5, shopifyQuantity: 3 },
  },
]

test('channel stock renders every state without a key warning', async (t: TestContext) => {
  const errors: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => { errors.push(String(args[0])) }
  t.after(() => { console.error = orig })
  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const node of [...document.body.children]) node.remove()
  })
  await act(async () => {
    root.render(React.createElement(ChannelStockTab, { rows }))
  })
  assert.ok(document.body.textContent?.includes('Shopify'), 'rows render')
  assert.deepEqual(errors.filter((e) => e.includes('unique "key"')), [])
})
