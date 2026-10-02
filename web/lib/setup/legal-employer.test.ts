import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { SqlExecutor } from '@openbooks/engine/platform/database'
import { SETUP_ENTITY_BY_KEY } from './registry'
import { validateEntityIntegrity } from './write'

const orgId = '019f0000-0000-7000-8000-000000000001'
const employerId = '019f0000-0000-7000-8000-000000000002'
const limit = SETUP_ENTITY_BY_KEY.get('entitlement-plan-limits')!

test('vacation employer ownership needs no multi-subsidiary feature and validates the legal entity', async () => {
  const statements: { sql: string; params: unknown[] }[] = []
  const executor = { execute: async (statement: SQL) => {
    statements.push(new PgDialect().sqlToQuery(statement))
    return { rows: [{ id: employerId }] }
  } } as SqlExecutor
  assert.equal(await validateEntityIntegrity(limit, { subsidiaryId: employerId }, orgId, undefined, executor), null)
  assert.equal(statements.length, 1)
  assert.deepEqual(statements[0]!.params, [orgId, employerId])
  assert.match(statements[0]!.sql, /is_active and not is_elimination/)
  assert.doesNotMatch(statements[0]!.sql, /org_feature/)
})

test('missing, inactive and foreign legal employers refuse with an actionable message', async () => {
  const executor = { execute: async () => ({ rows: [] }) } as unknown as SqlExecutor
  assert.match(await validateEntityIntegrity(limit, { subsidiaryId: employerId }, orgId, undefined, executor) ?? '', /Choose an active legal employer from this organization/)
  assert.match(await validateEntityIntegrity(limit, { subsidiaryId: 'invalid' }, orgId, undefined, executor) ?? '', /Choose a valid legal employer/)
})
