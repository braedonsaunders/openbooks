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

test('uuid keys become the document id verbatim', () => {
  const key = '6b0f23f3-f50e-4b80-a59d-d8c9f07b27a0'
  assert.equal(draftDocumentId(key), key)
})

test('opaque keys hash to a stable uuid', () => {
  const first = draftDocumentId('create-derive-1')
  const second = draftDocumentId('create-derive-1')
  assert.match(first, UUID)
  assert.equal(first, second)
  assert.notEqual(first, draftDocumentId('create-derive-2'))
})

test('empty keys refuse', () => {
  assert.throws(() => draftDocumentId(''), (error: unknown) => {
    assert.ok(error instanceof OrderDraftError)
    assert.equal(error.status, 400)
    return true
  })
  assert.throws(() => draftDocumentId('   '), /invalid_idempotency_key/)
})
