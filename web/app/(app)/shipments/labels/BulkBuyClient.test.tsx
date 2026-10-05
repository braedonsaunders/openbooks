import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/shipments/labels', matchMediaMatches: false })
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: true, intl: false, extra: { sonner: 'export const toast={success(){},error(){}}' } })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { BulkBuyClient } = await import('./BulkBuyClient')
const words = messages.fulfillment.shipping.bulk
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

async function mount(canBuy: boolean) {
  const calls: { url: string; body: Record<string, unknown> | null }[] = []
  let purchased = false
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    calls.push({ url, body })
    if (url.endsWith('/buy')) {
      purchased = true
      return Response.json({ rows: [{ shipmentId: 'shipment-a', ok: true, labelId: 'label-a', trackingNumber: 'TRACK-A', duplicate: false }], merged: { pages: 1, pdfBase64: 'cGRm' } })
    }
    if (init?.method === 'POST') return Response.json({ rows: [{ shipmentId: 'shipment-a', documentNumber: 'SHIP-101', ok: true, providerRateId: 'rate-a', carrier: 'Carrier', service: 'Ground', amount: '21.05', currency: 'USD', deliveryDate: null }] })
    return Response.json({ candidates: purchased ? [] : [{ shipmentId: 'shipment-a', documentNumber: 'SHIP-101', customerName: 'Customer', promisedDate: null, labelCount: 0 }] })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><BulkBuyClient canBuy={canBuy} accounts={[{ id: 'account-a', name: 'Test carrier', provider: 'shippo', mode: 'test', isDefault: true }]} /></NextIntlClientProvider>)
    await tick()
  })
  await act(async () => { await tick() })
  return { host, calls, async close() { await act(async () => root.unmount()); host.remove(); globalThis.fetch = prior } }
}

async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label)
  assert.ok(button, `expected ${label} to remain reachable`)
  await act(async () => { button.click(); await tick(); await tick() })
}

test('shipment selection, rates and purchased labels replace each other and retain the printed result', async () => {
  const view = await mount(true)
  try {
    assert.equal(view.host.querySelectorAll('table').length, 1)
    assert.ok(view.host.querySelector('input[type="checkbox"]'))
    await click(view.host, words.preview)
    assert.equal(view.host.querySelectorAll('table').length, 1, 'rates must replace the shipment selection table')
    assert.equal(view.host.querySelector('input[type="checkbox"]'), null)
    assert.match(view.host.textContent ?? '', /\$21\.05/)
    assert.equal(view.calls.filter(call => call.url.endsWith('/buy')).length, 0, 'previewing never purchases a label')
    await click(view.host, words.tabs.shipments)
    assert.equal(view.host.querySelector<HTMLInputElement>('input[aria-label="SHIP-101"]')?.checked, true, 'tab switching retains selected shipments')
    await click(view.host, words.tabs.rates)
    await click(view.host, words.buy)
    assert.equal(view.host.querySelectorAll('table').length, 0, 'purchase results replace rate and shipment tables')
    assert.match(view.host.textContent ?? '', /TRACK-A/)
    assert.ok(view.host.querySelector('a[download="shipping-labels.pdf"]'), 'candidate refresh cannot erase the purchased labels or print action')
    assert.equal(view.calls.filter(call => call.url.endsWith('/buy')).length, 1)
    assert.deepEqual(view.calls.find(call => call.url.endsWith('/buy'))?.body?.items, [{ shipmentId: 'shipment-a', providerRateId: 'rate-a' }])
  } finally { await view.close() }
})

test('a shipping reader can inspect rates without gaining a purchase action', async () => {
  const view = await mount(false)
  try {
    await click(view.host, words.preview)
    const buy = [...view.host.querySelectorAll('button')].find(node => node.textContent?.trim() === words.buy)
    assert.ok(buy?.disabled)
    assert.equal(view.calls.filter(call => call.url.endsWith('/buy')).length, 0)
  } finally { await view.close() }
})
