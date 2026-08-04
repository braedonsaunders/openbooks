import assert from 'node:assert/strict'
import test from 'node:test'
import { hasUnrestrictedQueryScope } from './query-console-access.ts'

test('query console fails closed for every subsidiary-restricted grant', () => {
  assert.equal(hasUnrestrictedQueryScope(null), true)
  assert.equal(hasUnrestrictedQueryScope(new Set()), false)
  assert.equal(hasUnrestrictedQueryScope(new Set(['019fba6a-9744-71d2-b8fe-5953f19c9096'])), false)
})
