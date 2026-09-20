import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Only the RSC bundling marker is replaced; policy and application error
// translation run unchanged, without a database or request/session context.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})
const web = await import('./documents.ts')
const policy = await import('@openbooks/engine/src/records/document-edit-policy.ts')
const reads = await import('@openbooks/engine/src/ledger/document-service.ts')
const { domainFailure } = await import('./application/documents.ts')
const { ApplicationError } = await import('./application/errors.ts')

test('web facade retains engine refusal identity and application conflict translation', () => {
  assert.equal(web.DocumentEditError, policy.DocumentEditError)
  const refusal = new policy.DocumentEditError(409, 'reload and review the latest revision', { revision: 'stale' })
  assert.ok(refusal instanceof web.DocumentEditError)
  assert.deepEqual(refusal.fieldErrors, { revision: 'stale' })
  assert.throws(() => domainFailure(refusal), (error: unknown) => error instanceof ApplicationError
    && error.status === 409 && error.message === refusal.message)
})

test('web compatibility exports compose the authoritative engine policies and reads', () => {
  assert.equal(web.buildReversalLinkEvidence, policy.buildReversalLinkEvidence)
  assert.equal(web.requireDocumentEditRevision, policy.requireDocumentEditRevision)
  assert.equal(web.runDocumentVersionedTransaction, policy.runDocumentVersionedTransaction)
  assert.equal(web.normalizeDocumentRecordRevisions, policy.normalizeDocumentRecordRevisions)
  assert.equal(web.loadDocumentEditCurrent, reads.loadDocumentEditCurrent)
  assert.equal(web.controlDeps, reads.controlDeps)
})
