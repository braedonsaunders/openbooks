import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules'
import { bootJsdomEnvironment } from '../testing/jsdom-env'

await bootJsdomEnvironment({ url: 'http://localhost/ap/bills?q=vendor&page=3', matchMediaMatches: false })
stubModules({ navigation: { source: 'export function usePathname(){return window.location.pathname}export function useSearchParams(){return new URLSearchParams(window.location.search)}export function useRouter(){return globalThis.__nativeListRouter}' }, intl: false, authz: false, features: false })
const React = await import('react')
Object.assign(globalThis, { React, __nativeListRouter: { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} } })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../messages/en')).default
const { MoneyProvider } = await import('./money-provider')
const { ListDrawerHost } = await import('./list-drawer-host')
const { ListDrawerLink } = await import('./list-drawer-link')
const { DOC_KINDS } = await import('../lib/document-kinds')
const id = '019f0000-0000-4000-8000-000000000003'
const selected = '/ap/bills?q=vendor&page=3&doc=' + id
const payload = {
  widget: 'document-drawer', drawer: {
    remountKey: id, basePath: '/ap/bills', config: DOC_KINDS.vendor_bill,
    payload: { doc: { id, kind: 'vendor_bill', status: 'draft', document_number: 'BILL-001', currency: 'CAD', updated_at: '1', document_date: '2026-09-30', subtotal: '10.0000', tax_total: '0.0000', total: '10.0000' }, lines: [] },
    accounts: [], parties: [], departments: [], projects: [], headerDefs: [], lineDefs: [],
    canCreate: false, canPost: false, canCustomize: false, allocationsEntryEnabled: false,
  },
}

test('a list opens one native drawer after detail loads and retains it on chrome changes', async (t) => {
  const prior = globalThis.fetch
  let finish!: (response: Response) => void
  const requests: string[] = []
  globalThis.fetch = ((url: unknown) => {
    requests.push(String(url))
    return new Promise<Response>((resolve) => { finish = resolve })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = prior })
  const render = async () => act(() => root.render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <MoneyProvider currency="CAD">
        <div data-list="unchanged"><ListDrawerLink href={selected}>BILL-001</ListDrawerLink></div>
        <ListDrawerHost source="vendor_bill" />
      </MoneyProvider>
    </NextIntlClientProvider>,
  ))
  await render()
  const list = host.querySelector('[data-list]')
  await act(() => host.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })))
  assert.equal(window.location.search, '?q=vendor&page=3&doc=' + id)
  await render()
  assert.equal(document.querySelector('[role="dialog"]'), null, 'loading must not create a second drawer shell')
  assert.equal(requests.length, 1)
  assert.ok(requests[0]!.startsWith('/api/lists/vendor_bill/drawer?'))
  await act(async () => { finish(Response.json(payload)); await new Promise((resolve) => setTimeout(resolve, 100)) })
  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog, 'the complete native drawer opens once')
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
  window.history.replaceState(null, '', selected + '&transactionTab=lines&drawerReturn=%2Fap%2Fbills%3Fq%3Dvendor%26page%3D3')
  await render()
  assert.equal(document.querySelector('[role="dialog"]'), dialog)
  assert.equal(host.querySelector('[data-list]'), list, 'list stays mounted throughout selection')
  assert.equal(requests.filter((url) => url.startsWith('/api/lists/')).length, 1, 'chrome changes never repeat record or list reads: ' + requests.join(', '))
})


test('a server deep link seeds once and reopening reauthorizes the record', async (t) => {
  window.history.replaceState(null, '', selected)
  const prior = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).startsWith('/api/lists/')) { requests++; return Response.json(payload) }
    return Response.json({})
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(async () => { await act(() => root.unmount()); host.remove(); globalThis.fetch = prior })
  const render = async () => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><MoneyProvider currency="CAD"><ListDrawerHost source="vendor_bill" initial={payload as Parameters<typeof ListDrawerHost>[0]['initial']} initialId={id} /></MoneyProvider></NextIntlClientProvider>)
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await render()
  assert.ok(document.querySelector('[role="dialog"]'))
  assert.equal(requests, 0, 'server deep links do not repeat their authorized read')
  window.history.replaceState(null, '', '/ap/bills?q=vendor&page=3')
  await render()
  window.history.replaceState(null, '', selected)
  await render()
  assert.equal(requests, 1, 'reopening never reuses an old server authorization or revision')
  assert.ok(document.querySelector('[role="dialog"]'))
})
