import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDocumentCreateRequest } from './document-drawer'

/**
 * The single write an unsaved create makes: first Save POSTs the collection
 * once with the drawer's own save payload plus the kind. The server runs the
 * shared writer on this body, so create validates exactly like an edit.
 */
test('create request carries kind plus the untouched save payload', () => {
  const payload = {
    partyId: 'party-1',
    documentDate: '2026-09-01',
    memo: 'hello',
    lines: [{ lineId: null, accountId: 'acct-1', amount: '100.00' }],
  }
  const request = buildDocumentCreateRequest('customer_invoice', payload, '11111111-1111-4111-8111-111111111111')
  assert.equal(request.path, '/api/documents')
  assert.equal(request.method, 'POST')
  assert.deepEqual(request.headers, {
    'Content-Type': 'application/json',
    'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
  })
  assert.deepEqual(request.body, { kind: 'customer_invoice', ...payload })
})

test('create request drops no drawer field: transfer legs ride along verbatim', () => {
  const payload = {
    partyId: null,
    paymentCardId: null,
    documentDate: '2026-09-01',
    memo: '',
    lines: [
      { accountId: 'bank-a', amount: '50.00', description: null },
      { accountId: 'bank-b', amount: '0', description: null },
    ],
  }
  const request = buildDocumentCreateRequest('transfer', payload, 'key-2')
  assert.equal((request.body.lines as unknown[]).length, 2)
  assert.deepEqual(request.body, { kind: 'transfer', ...payload })
})
