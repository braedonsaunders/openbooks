import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  DOCUMENT_CREATE_KINDS,
  documentCreateHref,
  isDocumentCreateKind,
} from './document-kinds'

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

test('uniform create covers exactly the nine shared document kinds', () => {
  assert.deepEqual([...DOCUMENT_CREATE_KINDS], [
    'customer_invoice',
    'customer_credit',
    'vendor_bill',
    'vendor_credit',
    'card_charge',
    'card_refund',
    'check',
    'deposit',
    'transfer',
  ])
  for (const kind of DOCUMENT_CREATE_KINDS) assert.equal(isDocumentCreateKind(kind), true)
})

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

test('NewDocumentButton performs zero writes: no fetch, no draft endpoint', () => {
  // Structural guard, labeled as such: the component must stay URL-only. If
  // this fires, someone reintroduced the instant-draft POST and every
  // open/cancel allocates a ghost row again.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'components', 'new-document-button.tsx'), 'utf8')
  assert.ok(!source.includes('fetch('), 'NewDocumentButton must not call fetch')
  assert.ok(!source.includes('/api/documents/draft'), 'NewDocumentButton must not invoke the draft factory')
  assert.ok(source.includes('documentCreateHref'), 'New navigates through the pinned href helper')
})
