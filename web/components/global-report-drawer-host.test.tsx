import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules'
import { bootJsdomEnvironment } from '../testing/jsdom-env'

await bootJsdomEnvironment({ url: 'http://localhost/reports/ar-aging', matchMediaMatches: false })
stubModules({ navigation: { source: 'export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return globalThis.__reportHostRouter}' }, intl: false, authz: false, features: false })
const React = await import('react')
Object.assign(globalThis, { React, __reportHostRouter: { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} } })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { MoneyProvider } = await import('./money-provider')
const { NavigationProvider } = await import('./navigation-provider')
const { GlobalReportDrawerHost } = await import('./global-report-drawer-host')

test('nested record and unrelated overlay chrome preserve the loaded drill and its request', async (t) => {
  const query = new URLSearchParams({ reportDrill: JSON.stringify({ kind: 'aging', label: 'AR', side: 'ar', asOf: '2026-09-30' }) })
  window.history.replaceState(null, '', '/reports/ar-aging?' + query)
  const prior = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (url: unknown) => {
    requests.push(String(url))
    if (String(url).includes('/accounts/')) return Response.json({ account: { id: '019f0000-0000-4000-8000-000000000004', number: '1000', name: 'Bank', type: 'asset_bank' }, lines: [], page: 1, perPage: 50, total: 0, balance: '0.0000' })
    return Response.json(String(url).includes('/transaction-drawer') ? null : {
      title: 'Open invoices', summary: [], columns: [{ label: 'Invoice' }], rows: [{ key: 'one', cells: ['INV-001'] }], page: 1, perPage: 50, total: 1,
    })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = prior })
  const render = async () => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><MoneyProvider currency="CAD"><NavigationProvider><GlobalReportDrawerHost /></NavigationProvider></MoneyProvider></NextIntlClientProvider>)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await render()
  const dialog = document.querySelector('[role="dialog"]')
  const row = document.querySelector('tbody tr')
  assert.ok(dialog && row)
  query.set('accountRegister', '019f0000-0000-4000-8000-000000000004')
  window.history.replaceState(null, '', '/reports/ar-aging?' + query)
  await render()
  query.set('reportRecord', '019f0000-0000-4000-8000-000000000003')
  query.set('reportRecordKind', 'customer_invoice')
  window.history.replaceState(null, '', '/reports/ar-aging?' + query)
  await render()
  query.set('transactionTab', 'lines')
  window.history.replaceState(null, '', '/reports/ar-aging?' + query)
  await render()
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.equal(document.querySelector('tbody tr'), row, 'loaded drill rows stay mounted under the record')
  assert.equal(requests.filter((url) => url.includes('/reports/drill?')).length, 1)
  assert.equal(requests.filter((url) => url.includes('/accounts/')).length, 1, 'the supporting account register also survives nested navigation')
  assert.equal(requests.filter((url) => url.includes('/transaction-drawer?')).length, 1)
})
