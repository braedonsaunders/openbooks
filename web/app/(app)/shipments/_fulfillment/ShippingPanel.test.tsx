import assert from 'node:assert/strict'
import test from 'node:test'
const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/shipments', matchMediaMatches: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: true, intl: false, extra: { sonner: 'export const toast={success(){},error(){}}' } })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { ShippingPanel } = await import('./ShippingPanel')
const words = messages.fulfillment.shipping
const tick = () => new Promise(resolve => setTimeout(resolve, 25))

async function mount(draft: boolean) {
  const prior = globalThis.fetch
  const writes: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      writes.push(url)
      return Response.json({ quote: { accountName: 'Test carrier', rates: [{ providerRateId: 'rate-a', carrier: 'Carrier', service: 'Ground', amount: '21.05', currency: 'USD', deliveryDate: null, deliveryDays: 2, badges: [] }] } })
    }
    return Response.json({ labels: ['A', 'B'].map(suffix => ({ id: `label-${suffix}`, carrier: 'Carrier', service: 'Ground', trackingNumber: `TRACK-${suffix}`, trackingStatus: 'in_transit', status: 'purchased', amountMinor: '2105', currency: 'USD', hasFile: true, labelUrl: null, events: [{ id: `event-${suffix}`, status: 'in_transit', detail: `Scan ${suffix}`, occurredAt: '2026-10-05' }] })) })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><ShippingPanel shipmentId="shipment-a" draft={draft} canBuy={false} accounts={[{ id: 'account-a', name: 'Test carrier', provider: 'shippo', mode: 'test', isDefault: true }]} presets={[]} /></NextIntlClientProvider>)
    await tick()
  })
  await act(async () => { await tick() })
  return { host, writes, async close() { await act(async () => root.unmount()); host.remove(); globalThis.fetch = prior } }
}
async function clickButton(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label || (node.hasAttribute('aria-pressed') && node.textContent?.startsWith(label)))
  assert.ok(button, `expected the native ${label} control`)
  await act(async () => { button.click(); await tick(); await tick() })
}

test('rate shopping replaces purchased labels and returning preserves the rate quote without buying', async () => {
  const view = await mount(true)
  try {
    assert.equal(view.host.querySelector('article'), null)
    await clickButton(view.host, words.getRates)
    assert.equal(view.host.querySelectorAll('table').length, 1)
    await clickButton(view.host, words.labelsTitle)
    assert.equal(view.host.querySelector('table'), null)
    assert.equal(view.host.querySelectorAll('article').length, 1)
    assert.match(view.host.querySelector('article')!.textContent!, /TRACK-A/)
    await clickButton(view.host, words.ratesTitle)
    assert.equal(view.host.querySelector('article'), null)
    assert.equal(view.host.querySelectorAll('table').length, 1)
    assert.deepEqual(view.writes, ['/api/shipping/rates'], 'switching concepts must not purchase or refresh tracking')
  } finally { await view.close() }
})

test('selecting a purchased label shows only its tracking evidence and print action', async () => {
  const view = await mount(false)
  try {
    const selector = view.host.querySelector<HTMLButtonElement>(`button[aria-label="${words.labelsTitle}"]`)
    assert.ok(selector)
    await act(async () => { selector.click(); await tick() })
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(node => node.textContent?.includes('TRACK-B'))
    assert.ok(option, 'the second parent label must remain reachable')
    await act(async () => { option.click(); await tick() })
    const article = view.host.querySelector('article')!
    assert.equal(view.host.querySelectorAll('article').length, 1)
    assert.match(article.textContent!, /TRACK-B/)
    assert.match(article.textContent!, /Scan B/)
    assert.doesNotMatch(article.textContent!, /TRACK-A|Scan A/)
    assert.match(article.querySelector('a')!.getAttribute('href')!, /label-B\/file$/)
    assert.deepEqual(view.writes, [])
  } finally { await view.close() }
})
