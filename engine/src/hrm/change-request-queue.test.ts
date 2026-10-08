import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'

const org = '00000000-0000-4000-8000-000000000001'
const actor = '00000000-0000-4000-8000-000000000002'
const subsidiary = '00000000-0000-4000-8000-000000000003'
const request = '00000000-0000-4000-8000-000000000004'
const dialect = new PgDialect()
const state = { active: true, queries: [] as ReturnType<PgDialect['sqlToQuery']>[], rows: [] as Record<string, unknown>[] }
Object.assign(globalThis, { __changeQueueExecute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
  const compiled = dialect.sqlToQuery(query)
  state.queries.push(compiled)
  const text = compiled.sql
  if (text.includes('is_super_admin')) return { rows: [{ isSuperAdmin: false, isActive: state.active }] }
  if (text.includes('role.permissions')) return { rows: [{ permissions: ['hrm.employment.read'] }] }
  if (text.includes('subsidiary_restriction')) return { rows: [{ restriction: { mode: 'list', subsidiaryIds: [subsidiary] } }] }
  if (text.includes('from subsidiaries')) return { rows: [{ id: subsidiary, parentId: null }] }
  if (text.includes('with visible as materialized')) return { rows: [{ n: '50', rows: state.rows }] }
  return { rows: [] }
} })
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    if (resolved.url.endsWith('/platform/db.ts')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      export * from ${JSON.stringify(new URL('../platform/db.ts?native', import.meta.url).href)};
      export const db = { execute: query => globalThis.__changeQueueExecute(query) };
      export async function withOrgTransaction(_org, run) { return run(db) }
    `) }
    return resolved
  },
})
const { listChangeRequestsWithTotal } = await import('./change-requests.ts')
const { HrmAuthorizationError } = await import('./authorization.ts')
hooks.deregister()

test('change request preview retains exact total, scoped selection and native DTO conversion', async () => {
  state.queries.length = 0
  state.rows = [{
    id: request, org_id: org, employment_id: actor, request_revision: 1, expected_employment_revision: 1,
    payload: { kind: 'status_change', status: 'active', effectiveFrom: '2026-10-01' },
    payload_digest: 'digest', payload_schema_version: '1', reason: null, status: 'pending_approval',
    submitted_by: actor, submitted_at: '2026-10-01T00:00:00Z', flow_run_id: null, decision_snapshot: null,
    applied_at: null, applied_by: null, applied_employment_revision: null, applied_employment_change_id: null,
    created_at: '2026-10-01T00:00:00Z', created_by: actor, updated_at: '2026-10-01T00:00:00Z', updated_by: actor,
  }]
  const result = await listChangeRequestsWithTotal({ orgId: org, actorId: actor, status: 'pending_approval', limit: 5 })
  assert.equal(result.total, 50)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.createdAt.toISOString(), '2026-10-01T00:00:00.000Z')
  const selections = state.queries.filter((query) => query.sql.includes('with visible as materialized'))
  assert.equal(selections.length, 1)
  assert.ok(selections[0]!.params.includes(org))
  assert.ok(selections[0]!.params.includes('pending_approval'))
  assert.ok(selections[0]!.params.includes(5))
  assert.ok(selections[0]!.params.some((value) => JSON.stringify(value).includes(subsidiary)))
  state.active = false
  state.queries.length = 0
  await assert.rejects(listChangeRequestsWithTotal({ orgId: org, actorId: actor, limit: 5 }), HrmAuthorizationError)
  assert.equal(state.queries.some((query) => query.sql.includes('with visible')), false)
  state.active = true
})

test('change request preview validates limits before authority reads', async () => {
  state.queries.length = 0
  for (const limit of [0, 501, 1.5]) {
    await assert.rejects(listChangeRequestsWithTotal({ orgId: org, actorId: actor, limit }), /limit must/)
  }
  assert.equal(state.queries.length, 0)
})
