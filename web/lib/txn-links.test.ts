import assert from 'node:assert/strict'
import test from 'node:test'
import { BANK_KINDS, DOC_KIND_FEATURE } from './document-kinds'
import { MODULE_BY_KEY } from './nav/registry'
import {
  assertTransactionLinkRegistry,
  moduleDrawerHref,
  TRANSACTION_KINDS,
  TRANSACTION_MODULE_BY_KIND,
  transactionNavigationOnlyFeature,
  transactionModule,
} from './txn-links'

const PROJECT_ID = '00000000-0000-0000-0000-000000000001'

test('every registered transaction resolves through an authorized native navigation module', () => {
  assert.doesNotThrow(() => assertTransactionLinkRegistry())
  for (const kind of TRANSACTION_KINDS) {
    const moduleKey = TRANSACTION_MODULE_BY_KIND[kind]
    const module = MODULE_BY_KEY.get(moduleKey)
    assert.ok(module, `${kind}: missing module ${moduleKey}`)
    assert.equal(transactionModule(kind), module)
    assert.ok(module.requiredPermission, `${kind}: module permission`)
    assert.ok(module.recordTarget, `${kind}: module record target`)
    const domainFeature = DOC_KIND_FEATURE[kind]
    if (domainFeature) assert.equal(module.featureKey, domainFeature, `${kind}: domain feature`)

    const href = moduleDrawerHref(kind, 'record-id', { projectId: PROJECT_ID })
    assert.ok(href, `${kind}: native href`)
    const url = new URL(href, 'https://openbooks.example')
    assert.ok(
      url.pathname === module.href || url.pathname.startsWith(`${module.href}/`),
      `${kind}: ${url.pathname} must be owned by ${module.href}`,
    )
    if (kind !== 'journal') assert.notEqual(url.pathname, '/journal', `${kind}: GL fallback`)
  }
})

test('Banking is navigation-only while generic bank documents remain domain-enabled', () => {
  for (const kind of BANK_KINDS) {
    assert.equal(DOC_KIND_FEATURE[kind], undefined, `${kind}: generic API feature gate`)
    assert.equal(transactionNavigationOnlyFeature(kind), 'banking', `${kind}: search/nav gate`)
    assert.equal(transactionModule(kind)?.featureKey, 'banking', `${kind}: module visibility`)
    assert.ok(moduleDrawerHref(kind, 'record-id')?.startsWith('/banking/transactions?doc='))
  }
})

test('module record targets build their declared query, nested, and project destinations', () => {
  for (const kind of TRANSACTION_KINDS) {
    const module = transactionModule(kind)
    assert.ok(module?.recordTarget)
    const href = moduleDrawerHref(kind, 'record/id', { projectId: PROJECT_ID })
    assert.ok(href)
    const url = new URL(href, 'https://openbooks.example')

    if (module.recordTarget.kind === 'query') {
      assert.equal(url.pathname, module.href)
      assert.equal(url.searchParams.get(module.recordTarget.param), 'record/id')
    } else if (module.recordTarget.kind === 'nested') {
      assert.equal(url.pathname, `${module.href}/${module.recordTarget.segment}/record%2Fid`)
    } else {
      assert.equal(url.pathname, module.href)
      assert.equal(url.searchParams.get('project'), PROJECT_ID)
      assert.equal(url.searchParams.get('projectTab'), 'transactions')
      assert.equal(url.searchParams.get('projectTxn'), 'record/id')
      assert.equal(url.searchParams.get('projectTxnKind'), kind)
    }
  }
})

test('AP, AR, and directional payments open the actual list-owned drawers', () => {
  assert.equal(moduleDrawerHref('vendor_bill', 'bill-id'), '/ap/bills?doc=bill-id')
  assert.equal(moduleDrawerHref('vendor_credit', 'credit-id'), '/ap/bills?doc=credit-id')
  assert.equal(moduleDrawerHref('customer_invoice', 'invoice-id'), '/ar/invoices?doc=invoice-id')
  assert.equal(moduleDrawerHref('customer_credit', 'credit-id'), '/ar/invoices?doc=credit-id')
  assert.equal(moduleDrawerHref('vendor_payment', 'payment-id'), '/payments?payment=payment-id')
  assert.equal(moduleDrawerHref('customer_payment', 'receipt-id'), '/receipts?payment=receipt-id')
})

test('unknown and absent document identities do not receive a fallback destination', () => {
  assert.equal(moduleDrawerHref('unclassified', 'record-id'), null)
  assert.equal(moduleDrawerHref('journal', null), null)
  assert.equal(moduleDrawerHref(null, 'record-id'), null)
})

test('shared navigation-catalog drift fails registry validation', () => {
  const moduleKey = TRANSACTION_MODULE_BY_KIND.vendor_bill
  const module = MODULE_BY_KEY.get(moduleKey)
  assert.ok(module)
  const recordTarget = module.recordTarget
  module.recordTarget = undefined
  try {
    assert.throws(
      () => assertTransactionLinkRegistry(),
      /vendor_bill: module "ap-bills" has no record target/,
    )
  } finally {
    module.recordTarget = recordTarget
  }
  assert.doesNotThrow(() => assertTransactionLinkRegistry())
})
