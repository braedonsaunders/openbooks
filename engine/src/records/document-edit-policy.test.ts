import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DocumentEditError,
  buildReversalLinkEvidence,
  normalizeDocumentRecordRevisions,
  requireDocumentEditRevision,
  runDocumentVersionedTransaction,
} from './document-edit-policy.ts'

// These imports intentionally run without server-only/Next/session shims. The
// refusal policy must remain usable by engine callers outside a web request.
test('revision policy preserves counters beyond JavaScript integer precision', () => {
  const revision = '9007199254740993'
  assert.equal(requireDocumentEditRevision(revision), revision)
  const row = { id: 'document', updated_at: new Date(), __documentRevision: revision }
  assert.deepEqual(normalizeDocumentRecordRevisions('documents', [row]), [
    { id: 'document', updated_at: revision },
  ])
  assert.equal(row.__documentRevision, revision, 'normalization must not mutate the driver row')
  assert.throws(() => normalizeDocumentRecordRevisions('documents', [{ updated_at: revision }]), /exact persisted revision/)
  assert.throws(() => requireDocumentEditRevision(undefined), (error: unknown) =>
    error instanceof DocumentEditError && error.status === 409 && /reload and review/.test(error.message))
})

test('a stale revision refuses inside the transaction before any mutation', async () => {
  const events: string[] = []
  const tx = { handle: 'transaction' }
  await assert.rejects(runDocumentVersionedTransaction({
    expectedRevision: '9007199254740992',
    transaction: async (work) => {
      events.push('begin')
      try { return await work(tx) } catch (error) { events.push('rollback'); throw error }
    },
    lock: async (actualTx) => {
      assert.equal(actualTx, tx)
      events.push('lock')
      return { updatedAt: '9007199254740993' }
    },
    mutate: async () => { events.push('mutate'); return true },
  }), (error: unknown) => error instanceof DocumentEditError && error.status === 409 && /reload and review/.test(error.message))
  assert.deepEqual(events, ['begin', 'lock', 'rollback'])
})

test('the locked row and transaction are passed unchanged to the mutation', async () => {
  const tx = { handle: 'transaction' }
  const row = { updatedAt: '12', status: 'draft' }
  const result = await runDocumentVersionedTransaction({
    expectedRevision: '12',
    transaction: (work) => work(tx),
    lock: async () => row,
    mutate: async (actualTx, actualRow) => {
      assert.equal(actualTx, tx)
      assert.equal(actualRow, row)
      return 'saved'
    },
  })
  assert.equal(result, 'saved')
})

test('a missing or inexact locked revision never authorizes mutation', async () => {
  for (const row of [null, { updatedAt: new Date() }, { updatedAt: 'bad-token' }]) {
    let mutated = false
    await assert.rejects(runDocumentVersionedTransaction({
      expectedRevision: '12',
      transaction: (work) => work({}),
      lock: async () => row,
      mutate: async () => { mutated = true },
    }), row === null
      ? (error: unknown) => error instanceof DocumentEditError && error.status === 404
      : /exact persisted revision/)
    assert.equal(mutated, false)
  }
})

test('correction evidence retains attribution and refuses inadmissible reasons', () => {
  const input = { fromDocumentId: 'replacement', toDocumentId: 'source', requestedBy: 'actor', reason: '  Correct the wrong account  ' }
  const evidence = buildReversalLinkEvidence(input)
  assert.equal(evidence.reason, 'Correct the wrong account')
  assert.equal(evidence.requestedBy, input.requestedBy)
  assert.equal(evidence.linkType, 'reverses')
  assert.ok(evidence.requestedAt instanceof Date)
  for (const reason of ['', 'short', 'a'.repeat(501)]) {
    assert.throws(() => buildReversalLinkEvidence({ ...input, reason }), (error: unknown) =>
      error instanceof DocumentEditError && error.status === 422 && /8 and 500/.test(error.message))
  }
  assert.throws(() => buildReversalLinkEvidence({ ...input, requestedBy: '' }), /attributable requester/)
})
