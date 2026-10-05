import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../testing/jsdom-env'
import { stubModules } from '../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/portal/session' })
stubModules({ navigation: true, extra: {
  'next-intl/server': 'export async function getLocale(){return "en"}export async function getTranslations(namespace){return globalThis.__portalTranslate(namespace)}',
  '@/lib/portal/pages': 'export async function portalPage(){return {home:globalThis.__portalAmountsHome,orgId:"org"}}',
  '@openbooks/engine/portal': 'export async function portalOrderTracking(){return []}',
  '@openbooks/engine/platform/database': 'export const db={};export async function withOrgContext(org,fn){return fn()}',
} })
const React = await import('react')
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { createTranslator, NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../messages/en')).default
Object.assign(globalThis, { __portalTranslate: (namespace: 'portal') => createTranslator({ locale: 'en', messages, namespace }) })
const { GiftCardForm } = await import('./portal-sections')
const { default: OrdersPage } = await import('../../app/portal/[token]/orders/page')
const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

test('gift-card lookup formats fixed four-decimal balances as customer money', async (t) => {
  const original = globalThis.fetch
  let currency = 'USD'
  let balanceMinor = '1234500'
  globalThis.fetch = async () => Response.json({ kind: 'gift_card', status: 'active', currency, balanceMinor })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => { globalThis.fetch = original; await act(async () => root.unmount()); host.remove() })
  await act(async () => root.render(<NextIntlClientProvider locale="en" messages={messages}><GiftCardForm sessionToken="session" labels={{ code: 'Card code', check: 'Check balance' }} /></NextIntlClientProvider>))
  const form = host.querySelector('form')!
  await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick() })
  assert.match(host.textContent ?? '', /\$123\.45/)
  assert.doesNotMatch(host.textContent ?? '', /1234500/)
  currency = 'BHD'; balanceMinor = '12340'
  await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick() })
  assert.match(host.textContent ?? '', /1\.234/)
  assert.doesNotMatch(host.textContent ?? '', /12340/)
})

function home(currency: string, totalMinor: string, minorUnits: number | null) {
  Object.assign(globalThis, { __portalAmountsHome: { settings: { portalName: 'Supplier' }, orders: [{ id: 'order', externalNumber: 'WEB-100', orderedAt: '2026-10-05', fulfilmentStatus: 'fulfilled', currency, totalMinor, minorUnits }] } })
}

test('portal orders use their registry precision rather than ledger precision', async () => {
  for (const [currency, totalMinor, minorUnits, expected] of [
    ['USD', '12345', 2, /\$123\.45/],
    ['BHD', '1234', 3, /1\.234/],
    ['JPY', '1234', 0, /1,234/],
  ] as const) {
    home(currency, totalMinor, minorUnits)
    const page = await OrdersPage({ params: Promise.resolve({ token: 'session' }) })
    assert.match(renderToStaticMarkup(page), expected, `${currency} order units must use exponent ${minorUnits}`)
  }
})

test('an order with unknown currency precision hides the amount and names the remedy', async () => {
  home('RHD', '12345', null)
  const page = await OrdersPage({ params: Promise.resolve({ token: 'session' }) })
  const html = renderToStaticMarkup(page)
  assert.match(html, /RHD/)
  assert.match(html, /Contact your supplier/)
  assert.doesNotMatch(html, /12345|1\.23/)
})
