import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost/collections?view=worklist&segment=overdue', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })
// Motion reads the global clock; browser frame timestamps use that same origin.
globalThis.requestAnimationFrame = (callback) => Number(setTimeout(() => callback(performance.now()), 16))
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
window.requestAnimationFrame = globalThis.requestAnimationFrame
window.cancelAnimationFrame = globalThis.cancelAnimationFrame
const navigations: string[] = []
Object.assign(globalThis, { __collectionsQueueRouter: { push: (href: string) => navigations.push(href), refresh() {}, replace() {} } })
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__collectionsQueueRouter} export function usePathname(){return window.location.pathname} export function useSearchParams(){return new URLSearchParams(window.location.search)}' })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('../../../components/money-provider')
const { NavigationProvider } = await import('../../../components/navigation-provider')
const { GlobalReportDrawerHost } = await import('../../../components/global-report-drawer-host')
const { DOC_KINDS } = await import('../../../lib/document-kinds')
const { CollectionsQueue } = await import('./CollectionsQueue')

test('invoice drill-down leaves Collections mounted with its search and selection intact', async (t) => {
  const invoiceId = '00000000-0000-4000-8000-000000000001'
  let loads = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/transaction-drawer?')) return Response.json({ type: 'document', props: {
      payload: { doc: { id: invoiceId, kind: 'customer_invoice', status: 'posted', document_number: 'INV-1042', currency: 'CAD',
        document_date: '2026-09-01', due_date: '2026-09-01', subtotal: '120.3400', tax_total: '0.0000', total: '120.3400', updated_at: '2026-09-01T00:00:00.000000Z' }, lines: [] },
      config: DOC_KINDS.customer_invoice, basePath: '/ar/invoices', relatedNavigation: true,
      parties: [], accounts: [], departments: [], projects: [], headerDefs: [], lineDefs: [],
      canCreate: false, canPost: false, allocationsEntryEnabled: false,
    } })
    if (url !== '/api/collections/worklist') return Response.json({})
    loads += 1
    return Response.json({ asOf: '2026-10-01', overdue: '120.3400', expectedThisWeek: '0.0000', canCollect: true,
      rows: [{ id: invoiceId, docId: invoiceId, docKind: 'customer_invoice', docNumber: 'INV-1042', partyName: 'Meridian', amount: '120.3400', dueDate: '2026-09-01', predictedDate: '2026-10-02', daysOverdue: 30, method: 'Overdue push' }] })
  }) as typeof fetch
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch })
  await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC"><MoneyProvider currency="CAD"><NavigationProvider><CollectionsQueue /><GlobalReportDrawerHost /></NavigationProvider></MoneyProvider></NextIntlClientProvider>); await new Promise((resolve) => setTimeout(resolve, 40)) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  const search = host.querySelector('input[aria-label="Search"]') as HTMLInputElement
  assert.ok(search)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(search, 'Meridian'); search.dispatchEvent(new window.Event('input', { bubbles: true })) })
  await act(async () => { host.querySelector<HTMLInputElement>('tbody input[type="checkbox"]')!.click() })
  const link = [...host.querySelectorAll('a')].find((candidate) => candidate.textContent === 'INV-1042')!
  assert.ok(link)
  await act(async () => link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })
  const url = new URL(window.location.href)
  assert.equal(url.pathname, '/collections')
  assert.equal(url.searchParams.get('view'), 'worklist')
  assert.equal(url.searchParams.get('segment'), 'overdue')
  assert.equal(url.searchParams.get('reportRecord'), invoiceId)
  assert.equal(url.searchParams.get('reportRecordKind'), 'customer_invoice')
  assert.equal(host.querySelector('input[aria-label="Search"]'), search, 'the underlying list keeps the same DOM node')
  assert.equal(search.value, 'Meridian')
  assert.equal(host.querySelector<HTMLInputElement>('tbody input[type="checkbox"]')!.checked, true)
  assert.equal(loads, 1, 'opening an invoice must not refetch the collection queue')
  assert.deepEqual(navigations, [], 'native drill-down must not navigate to the invoices page')
  const dialog = document.querySelector('[role="dialog"]')!
  assert.ok(dialog, 'the native invoice opens above the queue')
  assert.match(dialog.textContent ?? '', /INV-1042/)
  const close = [...dialog.querySelectorAll('button')].find((button) => /close/i.test(button.getAttribute('aria-label') ?? ''))!
  assert.ok(close)
  await act(async () => close.click())
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1000)) })
  assert.equal(window.location.pathname, '/collections')
  assert.equal(new URLSearchParams(window.location.search).get('reportRecord'), null)
  assert.equal(host.querySelector('input[aria-label="Search"]'), search)
  assert.equal(search.value, 'Meridian')
  assert.equal(host.querySelector<HTMLInputElement>('tbody input[type="checkbox"]')!.checked, true)
  assert.equal(loads, 1)
})
