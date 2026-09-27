import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import test from 'node:test'
import { subsidiaryScopeAllows, subsidiaryVisibleFilter } from '../../engine/src/organization/subsidiary-scope.ts'

const { guardSubsidiaryScope, subsidiariesInScope } = await import('./authz.ts')

/**
 * Subsidiary restriction is a visibility POLICY inside the tenant: the lists
 * narrow every query through allowedSubsidiaryIds, and a restricted caller
 * must not reach the same records by guessing an id. Record boundaries
 * consult the shared gate below; this file proves the gate itself fails
 * closed: out-of-scope reads exactly like nonexistent, assignments outside
 * the visible set are refused, and an empty scope denies everything.
 */

// ---------------------------------------------------------------------------
// The shared gate keeps the rule (fail closed)
// ---------------------------------------------------------------------------

test('subsidiaryScopeAllows fails closed on every unknown subsidiary', () => {
  const allowed = new Set(['sub-a'])
  assert.equal(subsidiaryScopeAllows(null, 'sub-unknown'), true)
  assert.equal(subsidiaryScopeAllows(allowed, 'sub-a'), true)
  assert.equal(subsidiaryScopeAllows(allowed, 'sub-b'), false)
  assert.equal(subsidiaryScopeAllows(allowed, null), false)
  assert.equal(subsidiaryScopeAllows(allowed, null, { orgWideNull: true }), true)
})

test('guardSubsidiaryScope denies with the same response as a missing record', async () => {
  const response = guardSubsidiaryScope(
    { allowedSubsidiaryIds: new Set(['sub-a']) } as never,
    'sub-b',
  )
  assert.equal(response?.status, 404)
  assert.deepEqual(await response?.json(), { error: 'not_found' })
})

test('subsidiariesInScope refuses assigning records outside the visible set', () => {
  const authz = { allowedSubsidiaryIds: new Set(['sub-a']) } as never
  assert.equal(subsidiariesInScope(authz, ['sub-a']), true)
  assert.equal(subsidiariesInScope(authz, ['sub-b']), false)
  assert.equal(subsidiariesInScope(authz, [null]), false)
})

test('the shared documents filter degrades to deny-all for an empty scope', () => {
  const query = new PgDialect().sqlToQuery(
    subsidiaryVisibleFilter(sql.raw('documents.subsidiary_id'), new Set()),
  )
  assert.match(query.sql, /and false/)
})
