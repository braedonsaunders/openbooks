import assert from 'node:assert/strict'
import test from 'node:test'

import { providerCommitRetryable, providerCommitStatusVariant } from './tax-provider-chip'

// The commit queue, the activity drawer and the document chip share one
// Badge vocabulary: a drift between them reads as two different states.
test('provider commit statuses map to the shared badge vocabulary', () => {
  assert.equal(providerCommitStatusVariant('committed'), 'success')
  assert.equal(providerCommitStatusVariant('pending'), 'secondary')
  assert.equal(providerCommitStatusVariant('failed'), 'warning')
  assert.equal(providerCommitStatusVariant('voided'), 'outline')
  assert.equal(providerCommitStatusVariant('skipped'), 'outline')
})

// Only a terminally failed row retries: committed, voided and pending rows
// refuse the retry route by name, so the UI must not offer it.
test('only failed rows with the filing grant offer a retry', () => {
  assert.equal(providerCommitRetryable(true, 'failed'), true)
  assert.equal(providerCommitRetryable(false, 'failed'), false)
  for (const status of ['pending', 'committed', 'voided', 'skipped']) {
    assert.equal(providerCommitRetryable(true, status), false)
  }
})
