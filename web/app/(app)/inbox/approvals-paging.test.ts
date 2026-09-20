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
const unionReader = readFileSync(
  new URL('../../../lib/application/approvals.ts', import.meta.url),
  'utf8',
)
const engineUnion = readFileSync(
  new URL('../../../../engine/src/flows/approval-worklist.ts', import.meta.url),
  'utf8',
)
const engineGates = readFileSync(
  new URL('../../../../engine/src/flows/gates.ts', import.meta.url),
  'utf8',
)
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

test('approvals union legs window in SQL with parameterized limits', () => {
  // Every leg carries a SQL LIMIT prefix (a static `limit 500` user picker
  // must not satisfy this); the global offset slices the bounded merge.
  assert.match(engineUnion, /limit \$\{/)
  assert.match(engineGates, /limit \$\{/)
  assert.match(engineUnion, /slice\(page\.offset/)
  // The loader windows through the paged reader, never the full fetch.
  assert.match(view, /approvalWorklistPageForAuthz\(authz/)
  assert.match(unionReader, /worklistApprovalsPage\(/)
})

test('approvals select-all is page-scoped and says so', () => {
  assert.match(table, /selectedOnPage/, 'toolbar must render the page-scoped selection copy')
  assert.match(table, /selectAllOnPage/, 'select-all must render the page-scoped label')
  assert.doesNotMatch(table, /no batch cap/, 'bulk cap comment must describe the real cap')
})

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
