import assert from 'node:assert/strict'
import test from 'node:test'
const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/channels/connect?channel=test-channel', matchMediaMatches: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: { source: "export function usePathname(){return '/channels/connect'};export function useRouter(){return{push(){},refresh(){}}};export function useSearchParams(){return new URLSearchParams('channel=test-channel')}" }, intl: false, extra: { sonner: 'export const toast={success(){},error(){}};export function Toaster(){return null}' } })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { ShopifyConnectWizard } = await import('./ShopifyConnectWizard')
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

test('Shopify review retains the named refusal and Refresh successfully retries it', async () => {
  const prior = globalThis.fetch
  let reviews = 0
  globalThis.fetch = async url => {
    if (!String(url).endsWith('/review')) return Response.json({ options: [] })
    reviews++
    return reviews === 1 ? Response.json({ error: 'This shop is not bound to this channel. Reconnect the intended shop.' }, { status: 422 }) : Response.json({ channel: { id: 'test-channel', name: 'Example shop', shop: 'example.myshopify.com', status: 'connected', currency: 'CAD' }, counts: { queued: 0, matched: 1, ignored: 0 }, via: { bySku: 1, byBarcode: 0 }, locations: { total: 1, mapped: 1 }, proposals: [], oauthAvailable: true })
  }
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><ShopifyConnectWizard /></NextIntlClientProvider>); await tick() })
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /not bound.*Reconnect the intended shop/)
    assert.equal(reviews, 1)
    const refresh = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === messages.common.actions.refresh)!
    await act(async () => { refresh.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await tick() })
    assert.equal(reviews, 2)
    assert.equal(host.querySelector('[role="alert"]'), null)
    assert.match(host.textContent!, /1 matched by SKU/)
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = prior }
})
