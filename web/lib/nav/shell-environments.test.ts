import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { beforeEach, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'

// Exercise real admission and permission resolution with database rows as the
// boundary. Every admission call reads again; no authority survives a request.
const state = { rows: [] as Record<string, unknown>[], queries: [] as { sql: string; params: unknown[] }[], bypass: 0, dialect: new PgDialect() }
;(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('openbooks.shell-environments-test')] = state
const database = 'data:text/javascript,' + encodeURIComponent(`
  const state = globalThis[Symbol.for('openbooks.shell-environments-test')];
  export const db = { async execute(query) { state.queries.push(state.dialect.sqlToQuery(query)); return {rows:state.rows}; } };
  export async function withBypassContext(work) { state.bypass++; return work(); }
`)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/platform/db.ts' && context.parentURL?.includes('/web/lib/org-access.ts')) return { url: database, shortCircuit: true }
    return next(specifier, context)
  },
})
const { resolveActiveEnv, enterableSandboxes } = await import('../org-access')
hooks.deregister()
const home = { id: '00000000-0000-4000-8000-000000000001', orgId: '00000000-0000-4000-8000-000000000002', isSuperAdmin: false }
const sandboxId = '00000000-0000-4000-8000-000000000003'
function sandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: sandboxId, name: 'Training', envKind: 'sandbox', sandboxOf: home.orgId,
    sourceUserId: home.id, sandboxName: 'Training', sandboxStatus: 'ready', sandboxTier: 'full',
    sandboxProductionOrgId: home.orgId, rolePermissions: [['admin.*']], overrides: [], sandboxUserId: 'cloned-member', ...overrides,
  }
}
beforeEach(() => { state.rows = [sandbox()]; state.queries = []; state.bypass = 0 })

test('sandbox permission revocation and explicit deny refuse the next admission', async () => {
  assert.equal((await resolveActiveEnv(home, sandboxId))?.actingUserId, 'cloned-member')
  state.rows = [sandbox({ overrides: [{ permission: 'admin.sandboxes.manage', effect: 'deny' }] })]
  assert.equal(await resolveActiveEnv(home, sandboxId), null)
  state.rows = [sandbox({ rolePermissions: [] })]
  assert.equal(await resolveActiveEnv(home, sandboxId), null)
  state.rows = [sandbox({ rolePermissions: [], overrides: [{ permission: 'admin.sandboxes.manage', effect: 'grant' }] })]
  assert.ok(await resolveActiveEnv(home, sandboxId))
  assert.equal(state.queries.length, 4, 'one live admission statement per call')
  assert.equal(state.bypass, 4)
  for (const query of state.queries) {
    assert.ok(query.params.includes(home.id))
    assert.ok(query.params.includes(home.orgId))
    assert.ok(query.params.includes(sandboxId))
  }
})

test('sandbox membership, lifecycle and backing organization remain required for platform administrators', async () => {
  for (const override of [
    { sourceUserId: null }, { sandboxUserId: null }, { sandboxStatus: 'cloning' },
    { sandboxOf: null }, { sandboxProductionOrgId: 'another-production-org' }, { sandboxName: null },
  ]) {
    state.rows = [sandbox(override)]
    assert.equal(await resolveActiveEnv({ ...home, isSuperAdmin: true }, sandboxId), null, JSON.stringify(override))
  }
  state.rows = [sandbox({ rolePermissions: [] })]
  assert.ok(await resolveActiveEnv({ ...home, isSuperAdmin: true }, sandboxId))
})

test('preview admission requires an active mapped identity even for platform administrators', async () => {
  state.rows = [sandbox({ envKind: 'preview', sourceUserId: null })]
  assert.equal(await resolveActiveEnv({ ...home, isSuperAdmin: true }, sandboxId), null)
  state.rows = [sandbox({ envKind: 'production', sourceUserId: null })]
  assert.equal((await resolveActiveEnv({ ...home, isSuperAdmin: true }, sandboxId))?.actingUserId, home.id)
  assert.equal(await resolveActiveEnv(home, sandboxId), null)
})

test('the switcher batches candidates and applies the same live admission rules', async () => {
  state.rows = [sandbox(), sandbox({ id: 'refused', overrides: [{ permission: 'admin.sandboxes.manage', effect: 'deny' }] })]
  const admitted = await enterableSandboxes(home, [home.orgId, '00000000-0000-4000-8000-000000000004'])
  assert.deepEqual(admitted.map(row => row.orgId), [sandboxId])
  assert.equal(state.queries.length, 1, 'candidate count does not increase database round trips')
  const query = state.queries[0]!
  assert.ok(query.sql.includes('any('))
  assert.ok(query.sql.includes("o.env_kind = 'sandbox'"))
  assert.ok(query.sql.includes('u.org_id = a.org_id and u.is_active'))
  assert.ok(query.sql.includes('r.org_id = ra.org_id'))
  assert.ok(query.sql.includes('m.org_id = o.id and m.is_active'))
  state.rows = [sandbox({ rolePermissions: [] })]
  assert.deepEqual(await enterableSandboxes(home, [home.orgId]), [])
  assert.equal(state.queries.length, 2, 'a later switcher request rechecks revoked authority')
  assert.deepEqual(await enterableSandboxes(home, []), [])
  assert.equal(state.queries.length, 2)
})
