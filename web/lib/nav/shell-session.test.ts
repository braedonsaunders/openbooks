import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { sessionSigningInput } from '../auth-token-format'

const { validateSessionToken } = await import('../auth')

test('session authentication requires the conditional activity update to affect a live session row', async () => {
  const previousSecret = process.env.SESSION_SECRET
  const secret = 'session-boundary-test-secret-at-least-32-characters'
  process.env.SESSION_SECRET = secret
  const sessionId = randomUUID(), userId = randomUUID()
  const expiry = Math.floor(Date.now() / 1000) + 3600
  const payload = `v2.${sessionId}.${userId}.${expiry}`
  const token = `${payload}.${createHmac('sha256', secret).update(sessionSigningInput(payload)).digest('base64url')}`
  const dialect = new PgDialect()
  const queries: { sql: string; params: unknown[] }[] = []
  let rows: unknown[] = [{ sessionId, userId, authMethod: 'password', expiresAt: new Date(expiry * 1000) }]
  const execute = db.execute
  db.execute = (async query => {
    queries.push(dialect.sqlToQuery(query as Parameters<PgDialect['sqlToQuery']>[0]))
    return { rows, rowCount: rows.length }
  }) as typeof db.execute
  try {
    assert.equal((await validateSessionToken(token))?.sessionId, sessionId)
    assert.equal(queries.length, 1, 'validation and stamp use a single statement')
    rows = []
    assert.equal(await validateSessionToken(token), null, 'zero affected rows after revocation cannot authenticate')
    assert.equal(queries.length, 2)
    for (const query of queries) {
      assert.ok(query.sql.includes('update auth_sessions s'))
      assert.ok(query.sql.includes('s.revoked_at is null'))
      assert.ok(query.sql.includes('s.expires_at > now()'))
      assert.ok(query.sql.includes('u.id = s.user_id and u.is_active'))
      assert.ok(query.sql.includes('returning s.user_id'))
      assert.ok(query.params.includes(sessionId))
      assert.ok(query.params.includes(userId))
      assert.ok(query.params.includes(createHash('sha256').update(token).digest('hex')))
    }
    assert.equal(await validateSessionToken('invalid'), null)
    assert.equal(queries.length, 2, 'invalid credentials never issue the stamp')
  } finally {
    db.execute = execute
    if (previousSecret === undefined) delete process.env.SESSION_SECRET
    else process.env.SESSION_SECRET = previousSecret
  }
})
