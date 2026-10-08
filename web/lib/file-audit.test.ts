import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SqlExecutor } from '@openbooks/engine/src/platform/db.ts'

const { recordFileEvent } = await import('./file-audit.ts')

const dialect = new PgDialect()

test('purging a file records an immutable delete event with its reason', async () => {
  let statement: { sql: string; params: unknown[] } | undefined
  const executor = {
    async execute(query: Parameters<typeof dialect.sqlToQuery>[0]) {
      statement = dialect.sqlToQuery(query)
      return { rows: [{ id: 'audit-1' }] }
    },
  }

  await recordFileEvent({
    orgId: 'org-1',
    actorId: 'user-1',
    table: 'files',
    rowId: 'file-1',
    action: 'purge',
    changes: { reason: 'retention expired' },
    executor: executor as unknown as SqlExecutor,
  })

  assert.ok(statement)
  assert.match(statement.sql, /insert into audit_log/)
  assert.deepEqual(statement.params, [
    'org-1',
    'files',
    'file-1',
    'delete',
    JSON.stringify({ event: 'purge', reason: 'retention expired' }),
    'user-1',
  ])
})

test('an audit insert failure rejects the file operation', async () => {
  const failure = new Error('audit storage unavailable')
  const executor = { async execute() { throw failure } }

  await assert.rejects(
    recordFileEvent({
      orgId: 'org-1',
      actorId: 'user-1',
      table: 'files',
      rowId: 'file-1',
      action: 'delete',
      executor: executor as unknown as SqlExecutor,
    }),
    (error) => error === failure,
  )
})

test('a file mutation cannot succeed when its required audit writes zero rows', async () => {
  await assert.rejects(recordFileEvent({ orgId: 'org-1',actorId: 'user-1',table: 'files',rowId: 'file-1',action: 'upload',
    executor: { execute: async () => ({ rows: [] }) } as unknown as SqlExecutor }),/did not persist/)
})
