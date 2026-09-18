import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const view = source('./view.ts')
const api = source('../../api/notifications/route.ts')
const registry = source('../../../../engine/src/modules/nav-registry.ts')

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

  // And the module carries no permission, deliberately — if one is ever added
  // the comment explaining why there is none must go with it.
  assert.match(
    registry,
    /key: 'notifications',\n\s+href: '\/notifications',\n\s+label: 'Notifications',\n\s+iconKey: 'bell',\n\s+group: 'my-work',\n\s+\}/,
    'the inbox module must stay ungated and unchanged in shape',
  )
})
