import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import {
  documentCreateHref,
  isDocumentCreateKind,
} from './document-kinds'

const dom = new (await import('jsdom')).JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/ar/invoices',
})
const domWindow = dom.window as unknown as Record<string, unknown>
const globals = globalThis as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
;(globalThis as typeof globalThis & { __documentCreateNavigations?: string[] }).__documentCreateNavigations = []
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {push(href){globalThis.__documentCreateNavigations.push(href)}}}',
      }
    }
    return nextResolve(specifier, context)
  },
})
const React = await import('react')
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
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
