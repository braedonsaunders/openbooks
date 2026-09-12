import assert from 'node:assert/strict'
import test from 'node:test'
import { documentDrawerHref } from './document-drawer-navigation'

for (const [idKey, kindKey, pathname, extra] of [
  ['partyTxn', 'partyTxnKind', '/entities/customers', 'relatedParty=party-1'],
  ['projectTxn', 'projectTxnKind', '/projects', 'project=project-1&projectTab=transactions'],
  ['reportRecord', 'reportRecordKind', '/reports/general-ledger', 'reportDrill=entry-1'],
] as const) {
  for (const kind of ['vendor_bill', 'customer_invoice', 'project_charge']) {
    test(`${kind} correction and form navigation retain ${idKey} context`, () => {
      const query = `${extra}&${idKey}=old&${kindKey}=${kind}&form=old-form&drawerReturn=%2Freports&transactionTab=audit`
      const args = { pathname, query, basePath: '/projects', currentId: 'old', kind, related: true }
      const correction = new URL(documentDrawerHref({ ...args, targetId: 'new/id' }), 'https://example.test')
      assert.equal(correction.pathname, pathname)
      assert.equal(correction.searchParams.get(idKey), 'new/id')
      assert.equal(correction.searchParams.get(kindKey), kind)
      assert.equal(correction.searchParams.get('drawerReturn'), '/reports')
      assert.equal(correction.searchParams.has('doc'), false)
      assert.equal(correction.searchParams.has('form'), false)
      assert.equal(correction.searchParams.has('transactionTab'), false)
      for (const [key, value] of new URLSearchParams(extra)) assert.equal(correction.searchParams.get(key), value)
      const form = new URL(documentDrawerHref({ ...args, targetId: 'old', form: 'layout&1' }), 'https://example.test')
      assert.equal(form.searchParams.get(idKey), 'old')
      assert.equal(form.searchParams.get('form'), 'layout&1')
    })
  }
}
test('native list navigation uses its actual base path and encodes the form', () => {
  const href = documentDrawerHref({ pathname: '/ar/invoices', query: 'doc=old&filter=active', basePath: '/ar/invoices', currentId: 'old', targetId: 'new/id', kind: 'customer_invoice', form: 'layout&1' })
  const url = new URL(href, 'https://example.test')
  assert.equal(url.pathname, '/ar/invoices')
  assert.equal(url.searchParams.get('doc'), 'new/id')
  assert.equal(url.searchParams.get('form'), 'layout&1')
})
test('a related project charge without a selected host uses the global record host', () => {
  const href = documentDrawerHref({ pathname: '/reports/general-ledger', query: 'period=2026-09', basePath: '/projects', currentId: 'old', targetId: 'new', kind: 'project_charge', related: true })
  const url = new URL(href, 'https://example.test')
  assert.equal(url.pathname, '/reports/general-ledger')
  assert.equal(url.searchParams.get('reportRecord'), 'new')
  assert.equal(url.searchParams.get('reportRecordKind'), 'project_charge')
  assert.equal(url.searchParams.get('drawerReturn'), '/reports/general-ledger?period=2026-09')
})
