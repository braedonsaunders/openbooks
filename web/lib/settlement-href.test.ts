import assert from 'node:assert/strict'
import test from 'node:test'
import { documentSettlementHref, settlementHrefFor } from './settlement-href.ts'

const PARTY = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const invoice = { id: DOC, kind: 'customer_invoice', status: 'posted', party_id: PARTY, open_balance: '1000.0000' }
const both = { ar: true, ap: true }

test('a posted invoice with an open balance offers Receive payment for its customer and itself', () => {
  assert.equal(
    documentSettlementHref(invoice, both),
    `/receipts?paymentNew=1&mode=edit&partyId=${PARTY}&applyTo=${DOC}`,
  )
  assert.equal(
    documentSettlementHref({ ...invoice, kind: 'vendor_bill' }, both),
    `/payments?paymentNew=1&mode=edit&partyId=${PARTY}&applyTo=${DOC}`,
  )
})

test('settled, unposted, party-less or unpermitted documents offer no settlement', () => {
  assert.equal(documentSettlementHref({ ...invoice, open_balance: '0.0000' }, both), null)
  assert.equal(documentSettlementHref({ ...invoice, open_balance: null }, both), null)
  assert.equal(documentSettlementHref({ ...invoice, status: 'approved' }, both), null)
  assert.equal(documentSettlementHref({ ...invoice, party_id: null }, both), null)
  assert.equal(documentSettlementHref({ ...invoice, kind: 'customer_credit' }, both), null)
  assert.equal(documentSettlementHref(invoice, { ar: false, ap: true }), null)
  assert.equal(documentSettlementHref({ ...invoice, kind: 'vendor_bill' }, { ar: true, ap: false }), null)
})

test('a party-level link opens the new payment for the party alone', () => {
  assert.equal(settlementHrefFor('ar', PARTY), `/receipts?paymentNew=1&mode=edit&partyId=${PARTY}`)
  assert.equal(settlementHrefFor('ap', PARTY), `/payments?paymentNew=1&mode=edit&partyId=${PARTY}`)
})
