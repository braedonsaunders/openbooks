import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('query console echoes only schema-free validation messages', () => {
  const route = source('app/api/query/route.ts')

  // Pure pre-validation runs before execution; its messages carry no schema.
  assert.match(route, /validateUserSql\(body\.sql\)/)
  assert.match(route, /e instanceof Error \? e\.message : "invalid query"/)

  // Execution errors are logged server-side and returned generically —
  // the raw PostgreSQL message must never reach the client.
  assert.match(route, /console\.error\("\[query-console\] execution failed", e\)/)
  assert.match(route, /\{ error: "query failed" \}, \{ status: 400 \}/)
  assert.doesNotMatch(route, /error: message/)
})

test('insights query sanitizes the fallback without losing the timeout translation', () => {
  const route = source('app/api/insights/query/route.ts')

  // The statement-timeout translation still tests the RAW message and runs
  // BEFORE the generic fallback.
  const timeoutIndex = route.indexOf('/statement timeout|canceling statement/i')
  const fallbackIndex = route.indexOf("error: 'query failed'")
  assert.ok(timeoutIndex > -1, 'timeout regex preserved')
  assert.ok(fallbackIndex > timeoutIndex, 'timeout translation precedes the generic fallback')

  // The final fallback logs server-side and returns a generic message;
  // compile/validation error branches stay verbatim (translated or structural).
  assert.match(route, /console\.error\('\[insights-query\] execution failed', e\)/)
  assert.match(route, /InsightCompileError/)
  assert.match(route, /insightCompileErrorMessage/)
})
