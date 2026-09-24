import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Static pins for the approvals paging lane: the worklist windows in SQL
// (parameterized LIMIT prefixes on the union legs — never an unbounded leg
// fetch feeding a slice), select-all is honestly page-scoped, and one page
// always fits one bulk request through a single shared ceiling.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const view = source('./view.ts')
const table = source('./ApprovalsTable.tsx')
const limits = readFileSync(
  new URL('../../../lib/approvals-limits.ts', import.meta.url),
  'utf8',
)
const bulkRoute = readFileSync(
  new URL('../../api/flows/gates/bulk/route.ts', import.meta.url),
  'utf8',
)
const bulkLimit = readFileSync(
  new URL('../../api/flows/gates/bulk/bulk-limit.ts', import.meta.url),
  'utf8',
)

test('one approvals page always fits one bulk request', () => {
  assert.match(limits, /APPROVALS_BULK_BATCH_MAX\s*=\s*50/)
  for (const [name, src] of [
    ['loader', view],
    ['table', table],
  ] as const) {
    assert.match(src, /APPROVALS_BULK_BATCH_MAX/, `${name} must use the shared ceiling`)
  }
  // The bulk route reaches the ceiling through its MAX_BULK_ITEMS alias; the
  // alias itself must stay bound to the shared ceiling so the two cannot drift.
  assert.match(bulkRoute, /MAX_BULK_ITEMS/, 'bulk route must use the shared ceiling')
  assert.match(bulkLimit, /MAX_BULK_ITEMS\s*=\s*APPROVALS_BULK_BATCH_MAX/, 'bulk alias must stay bound to the shared ceiling')
})
