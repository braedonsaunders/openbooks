import assert from 'node:assert/strict'
import test from 'node:test'

import { statusDisplayInput, tagStaticStatusOption } from './status-display-input.ts'

test('static options resolve status display names from their stable code', () => {
  const tagged = tagStaticStatusOption({ value: 'suggested', labelKey: 'planning.status.suggested' }, 'Suggested')
  assert.deepEqual(tagged, { value: 'suggested', label: 'Suggested', stableCode: 'suggested' })
  assert.equal(statusDisplayInput(tagged), 'suggested')
})

test('static options without a labelKey resolve from their label', () => {
  const tagged = tagStaticStatusOption({ value: 'failed' }, 'failed')
  assert.deepEqual(tagged, { value: 'failed', label: 'failed' })
  assert.equal(statusDisplayInput(tagged), 'failed')
})

test('tenant-loaded options resolve from their stored name, never a database id', () => {
  assert.equal(statusDisplayInput({ value: '9f2c1a40-uuid', label: 'Closed lost' }), 'Closed lost')
})
