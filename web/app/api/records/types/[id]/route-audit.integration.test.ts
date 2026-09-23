import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Builder saves and draft deletes mutate record-type configuration, so each
// one must leave immutable auditSetupChange evidence in the SAME transaction:
// a PATCH carries before/after of the configuration it mutates (fields,
// roles, key), a DELETE carries the removed draft's before-image. A committed
// save without its evidence is a lost audit surface.

const stateKey = Symbol.for('openbooks.record-type-audit-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.record-type-audit-test')]
  export async function guardPermission() {
    if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    return state.authz;
  }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (
      specifier === '../../../../../lib/authz' &&
      context.parentURL?.includes('/api/records/')
    ) {
      return { url: 'mock:record-type-audit-authz', shortCircuit: true }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 5)
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context)
    }
    if (context.parentURL?.startsWith('mock:') && (specifier.startsWith('@openbooks/') || specifier === 'next/server')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:record-type-audit-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?record-type-audit-test'
const { GET, PATCH, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

const auditFields = [{
  id: 'main',
  title: 'Details',
  fields: [{ id: 'title', type: 'text', label: 'Title' }],
}]

function authz(actorId: string, orgId: string) {
  return {
    user: { id: actorId, orgId, roles: [{ key: 'admin', name: 'Admin' }] },
    permissions: new Set(['records.manage_types']),
    allowedSubsidiaryIds: null,
  }
}

async function insertDraft(orgId: string, actorId: string): Promise<string> {
  const typeId = randomUUID()
  await db.execute(sql`
    insert into custom_record_types
      (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
    values
      (${typeId}, ${orgId}, ${`audit-${typeId.slice(0, 8)}`}, 'Audit Type', 'Audit Types',
       ${JSON.stringify(auditFields)}::jsonb, 'draft', ${actorId}, ${actorId})
  `)
  return typeId
}

async function openedRevision(id: string): Promise<string> {
  const opened = await GET(
    new Request(`http://localhost/api/records/types/${id}`),
    { params: Promise.resolve({ id }) },
  )
  assert.equal(opened.status, 200, await opened.clone().text())
  return ((await opened.json()) as { type: { updated_at: string } }).type.updated_at
}

async function auditEvents(orgId: string, rowId: string) {
  return (await db.execute<{ action: string; changes: unknown; actor_id: string }>(sql`
    select action, changes, actor_id from audit_log
     where org_id = ${orgId} and table_name = 'custom_record_types' and row_id = ${rowId}
     order by at, id
  `)).rows
}

test(
  'a builder PATCH commits before/after configuration evidence in the same unit',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      return { org: created, actorId: actor }
    })

    state.authz = authz(actorId, org.orgId)
    try {
      await withOrgContext(org.orgId, async () => {
        const typeId = await withBypass(() => insertDraft(org.orgId, actorId))
        const revision = await openedRevision(typeId)
        const patched = await PATCH(
          new Request(`http://localhost/api/records/types/${typeId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed Audit Type', expectedUpdatedAt: revision }),
          }),
          { params: Promise.resolve({ id: typeId }) },
        )
        assert.equal(patched.status, 200, await patched.clone().text())

        const events = await auditEvents(org.orgId, typeId)
        assert.equal(events.length, 1, 'one configuration audit event per save')
        assert.equal(events[0]!.action, 'update')
        assert.equal(events[0]!.actor_id, actorId)
        const changes = events[0]!.changes as { before: { name: string }; after: { name: string } }
        assert.equal(changes.before.name, 'Audit Type')
        assert.equal(changes.after.name, 'Renamed Audit Type')
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'a refused PATCH commits no audit event',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      return { org: created, actorId: actor }
    })

    state.authz = authz(actorId, org.orgId)
    try {
      await withOrgContext(org.orgId, async () => {
        const typeId = await withBypass(() => insertDraft(org.orgId, actorId))
        const refused = await PATCH(
          new Request(`http://localhost/api/records/types/${typeId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Lost Rename', expectedUpdatedAt: '2000-01-01T00:00:00.000000Z' }),
          }),
          { params: Promise.resolve({ id: typeId }) },
        )
        assert.equal(refused.status, 409, await refused.clone().text())
        assert.equal((await auditEvents(org.orgId, typeId)).length, 0, 'a refused save audits nothing')
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'a draft DELETE leaves an immutable delete event with the removed configuration',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      return { org: created, actorId: actor }
    })

    state.authz = authz(actorId, org.orgId)
    try {
      await withOrgContext(org.orgId, async () => {
        const typeId = await withBypass(() => insertDraft(org.orgId, actorId))
        const deleted = await DELETE(
          new Request(`http://localhost/api/records/types/${typeId}`, { method: 'DELETE' }),
          { params: Promise.resolve({ id: typeId }) },
        )
        assert.equal(deleted.status, 200, await deleted.clone().text())

        const events = await auditEvents(org.orgId, typeId)
        assert.equal(events.length, 1, 'one delete event per removed draft')
        assert.equal(events[0]!.action, 'delete')
        assert.equal(events[0]!.actor_id, actorId)
        const changes = events[0]!.changes as { before: { key: string; status: string } }
        assert.equal(changes.before.status, 'draft')
        assert.match(changes.before.key, /^audit-/)
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
