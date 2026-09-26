import assert from 'node:assert/strict'
import test from 'node:test'

// Only the RSC bundling marker is replaced; policy and error translation are real.
const { DocumentEditError } = await import('@openbooks/engine/src/records/document-edit-policy.ts')
const { domainFailure } = await import('./application/documents.ts')
const { ApplicationError } = await import('./application/errors.ts')

test('application preserves engine refusal status, details and remedy', () => {
  const refusal = new DocumentEditError(409, 'reload and review the latest revision', { revision: 'stale' })
  assert.deepEqual(refusal.fieldErrors, { revision: 'stale' })
  assert.throws(() => domainFailure(refusal), (error: unknown) => error instanceof ApplicationError
    && error.status === 409 && error.message === refusal.message)
})
