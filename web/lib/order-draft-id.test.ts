import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})
const { draftDocumentId, OrderDraftError } = await import('./order-cycle')

// The draft document id derives deterministically from the idempotency key:
// UUID keys pass through verbatim, opaque v1 keys hash to a stable UUID, so
// every caller shares the one claim/replay/insert system and a retry replays.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const ORG_A = '00000000-0000-4000-8000-0000000000a1'
const ORG_B = '00000000-0000-4000-8000-0000000000b2'

test('uuid keys become the document id verbatim', () => {
  const key = '6b0f23f3-f50e-4b80-a59d-d8c9f07b27a0'
  assert.equal(draftDocumentId(ORG_A, key), key)
})

test('opaque keys hash to a stable uuid', () => {
  const first = draftDocumentId(ORG_A, 'create-derive-1')
  const second = draftDocumentId(ORG_A, 'create-derive-1')
  assert.match(first, UUID)
  assert.equal(first, second)
  assert.notEqual(first, draftDocumentId(ORG_A, 'create-derive-2'))
})

test('the same opaque key in two orgs maps to two document ids', () => {
  assert.notEqual(draftDocumentId(ORG_A, 'order-1'), draftDocumentId(ORG_B, 'order-1'))
})

test('empty keys refuse', () => {
  assert.throws(() => draftDocumentId(ORG_A, ''), (error: unknown) => {
    assert.ok(error instanceof OrderDraftError)
    assert.equal(error.status, 400)
    return true
  })
  assert.throws(() => draftDocumentId(ORG_A, '   '), /invalid_idempotency_key/)
})
