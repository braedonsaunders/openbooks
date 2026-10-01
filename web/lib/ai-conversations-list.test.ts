import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { Authz } from './authz'
import { stubModules } from '../testing/stub-modules'

const queries: { sql: string; params: unknown[] }[] = []
const dialect = new PgDialect()
Object.assign(globalThis, {
  __conversationListExecute: async (query: SQL) => {
    queries.push(dialect.sqlToQuery(query))
    return { rows: [] }
  },
})
stubModules({ extra: {
  '@openbooks/engine/src/platform/db.ts':
    'export const db = { execute: (query) => globalThis.__conversationListExecute(query) }',
} })
const { listConversations } = await import('./ai-conversations')
const authz = { user: { orgId: 'owner-org', id: 'owner-user' } } as Authz

test('assistant history has no hidden row cap and remains owner, organization and scope isolated', async () => {
  await listConversations(authz, 'assistant')
  const query = queries.at(-1)!
  assert.doesNotMatch(query.sql, /\blimit\b/i, 'every conversation must be available before any deletion')
  assert.match(query.sql, /where org_id = \$1 and user_id = \$2 and scope = \$3/)
  assert.deepEqual(query.params, ['owner-org', 'owner-user', 'assistant'])
  assert.match(query.sql, /order by updated_at desc, id desc/, 'equal timestamps must have stable ordering')
})

test('briefing callers can still request a bounded recent window', async () => {
  await listConversations(authz, 'briefing', 5)
  const query = queries.at(-1)!
  assert.match(query.sql, /limit \$4/)
  assert.deepEqual(query.params, ['owner-org', 'owner-user', 'briefing', 5])
})
