import assert from 'node:assert/strict'
import test from 'node:test'
import {
  documentCreateHref,
  isDocumentCreateKind,
} from './document-kinds'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

stubModules({ navigation: { source: 'export function useRouter(){return {push(href){globalThis.__documentCreateNavigations.push(href)}}}' }, intl: false, authz: false, features: false });

await bootJsdomEnvironment({ html: '<!doctype html><html><body></body></html>', url: 'http://localhost/ar/invoices' });
;(globalThis as typeof globalThis & { __documentCreateNavigations?: string[] }).__documentCreateNavigations = []
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NewDocumentButton } = await import('../components/new-document-button.tsx')

/**
 * URL-only uniform create contract: clicking New navigates to `?doc=new&kind=`
 * and allocates nothing. These hrefs are the parent-wiring surface — one
 * direct href per creatable kind — so they are pinned exactly.
 */
const DIRECT_HREFS: [basePath: string, kind: string, href: string][] = [
  ['/ar/invoices', 'customer_invoice', '/ar/invoices?doc=new&kind=customer_invoice&mode=edit'],
  ['/ar/invoices', 'customer_credit', '/ar/invoices?doc=new&kind=customer_credit&mode=edit'],
  ['/ap/bills', 'vendor_bill', '/ap/bills?doc=new&kind=vendor_bill&mode=edit'],
  ['/ap/bills', 'vendor_credit', '/ap/bills?doc=new&kind=vendor_credit&mode=edit'],
  ['/banking/transactions', 'card_charge', '/banking/transactions?doc=new&kind=card_charge&mode=edit'],
  ['/banking/transactions', 'card_refund', '/banking/transactions?doc=new&kind=card_refund&mode=edit'],
  ['/banking/transactions', 'check', '/banking/transactions?doc=new&kind=check&mode=edit'],
  ['/banking/transactions', 'deposit', '/banking/transactions?doc=new&kind=deposit&mode=edit'],
  ['/banking/transactions', 'transfer', '/banking/transactions?doc=new&kind=transfer&mode=edit'],
  ['/cash-sales', 'cash_sale', '/cash-sales?doc=new&kind=cash_sale&mode=edit'],
  ['/cash-sales', 'cash_refund', '/cash-sales?doc=new&kind=cash_refund&mode=edit'],
]

test('one exact direct href per creatable kind', () => {
  for (const [basePath, kind, href] of DIRECT_HREFS) {
    assert.equal(documentCreateHref(basePath, kind), href, kind)
  }
})

test('create href refuses non-document kinds by name instead of routing them', () => {
  for (const kind of ['project_charge', 'pay_run', 'sales_order', 'journal', 'customer_payment', '', 'invoice']) {
    assert.equal(isDocumentCreateKind(kind), false, kind)
    assert.throws(() => documentCreateHref('/ar/invoices', kind), /is not creatable here/, kind)
  }
})

test('choosing New navigates to an in-memory draft without sending a write request', async (t) => {
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return Response.json({ ok: true })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = originalFetch
  })

  await act(async () => {
    root.render(React.createElement(NewDocumentButton, {
      items: [{ kind: 'customer_invoice', label: 'Invoice' }],
      basePath: '/ar/invoices',
      triggerLabel: 'New',
    }))
  })
  const create = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Invoice'))
  assert.ok(create, 'the invoice create action is visible')
  await act(async () => create.click())

  assert.deepEqual(
    (globalThis as typeof globalThis & { __documentCreateNavigations: string[] }).__documentCreateNavigations,
    ['/ar/invoices?doc=new&kind=customer_invoice&mode=edit'],
  )
  assert.deepEqual(calls, [], 'opening a draft must not create a server row')
})

test('a multi-kind New dropdown lists every kind it was given', async (t) => {
  const navigations = (globalThis as typeof globalThis & { __documentCreateNavigations: string[] }).__documentCreateNavigations
  navigations.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(React.createElement(NewDocumentButton, {
      items: [{ kind: 'cash_sale', label: 'New cash sale' }, { kind: 'cash_refund', label: 'New cash refund' }],
      basePath: '/cash-sales',
      triggerLabel: 'New',
    }))
  })
  const trigger = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('New'))
  assert.ok(trigger, 'the split trigger renders')
  await act(async () => {
    trigger.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const options = [...document.body.querySelectorAll('[data-ui-overlay] button')].map((button) => button.textContent)
  assert.deepEqual(options, ['New cash sale', 'New cash refund'], 'the dropdown never opens empty')
  const refund = [...document.body.querySelectorAll('[data-ui-overlay] button')].find((button) => button.textContent === 'New cash refund') as HTMLButtonElement
  await act(async () => refund.click())
  assert.deepEqual(navigations, ['/cash-sales?doc=new&kind=cash_refund&mode=edit'])
})

test('a New button with no creatable kind renders no control', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(React.createElement(NewDocumentButton, { items: [], basePath: '/cash-sales', triggerLabel: 'New' }))
  })
  assert.equal(host.querySelectorAll('button').length, 0)
})
