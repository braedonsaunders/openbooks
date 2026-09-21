import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const view = source('./view.ts')
const api = source('../../api/notifications/route.ts')
const registry = source('../../../../engine/src/navigation/nav-registry.ts')

/**
 * The inbox is the one nav module with no permission key, and that is only
 * defensible while every query is scoped to the session's own user AND their
 * organization. Nothing about the surface makes that visible at review time —
 * a filter dropped from one of five queries would read as a refactor — so the
 * claim is pinned here.
 */
test('every inbox query is scoped to the signed-in user and their organization', () => {
  // One derived predicate, used by the page's list, its counts, and its
  // filter chips, so a scope can only be lost in one place rather than three.
  assert.match(view, /const mine = sql`org_id = \$\{orgId\} and user_id = \$\{userId\}`/)
  const rawScopes = view.match(/from notifications\s+where (?!\$\{(filtered|scoped|mine)\})/g) ?? []
  assert.deepEqual(rawScopes, [], 'no inbox query may build its own unscoped WHERE')

  // The mark-read API is self-scoped the same way on both of its writes.
  const apiScopes = api.match(/org_id = \$\{orgId\} and user_id = \$\{userId\}/g) ?? []
  assert.ok(apiScopes.length >= 3, `expected every API query scoped, found ${apiScopes.length}`)
  assert.doesNotMatch(api, /where\s+id\s+in\s*\(select/i)

  // HR-15 rebrand: notices are no nav module — My Work shows one Inbox
  // entry and notices surface as its Notices filter. The route, page, and
  // API above stay directly reachable (and self-scoped); only the registry
  // entry collapsed into the approvals-keyed Inbox module.
  assert.doesNotMatch(registry, /key: 'notifications'/, 'notices must not be a nav module')
  assert.match(registry, /key: 'approvals',\n\s+href: '\/inbox'/, 'the approvals-keyed module targets the inbox')
})
