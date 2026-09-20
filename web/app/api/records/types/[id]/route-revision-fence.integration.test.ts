import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.record-type-revision-fence-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.record-type-revision-fence-test')]
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
    if (specifier === '../../../../../lib/authz' && context.parentURL?.includes('/api/records/')) {
      return { url: 'mock:record-type-revision-fence-authz', shortCircuit: true }
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
    if (url === 'mock:record-type-revision-fence-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?record-type-revision-fence-test'
const { GET, PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

const scopedFields = [{
  id: 'main',
  title: 'Details',
  fields: [
    { id: 'subsidiary_id', type: 'text', label: 'Subsidiary' },
    { id: 'title', type: 'text', label: 'Title' },
  ],
}]
const unscopeFields = [{
  id: 'main',
  title: 'Details',
  fields: [{ id: 'title', type: 'text', label: 'Title' }],
}]

function authz(actorId: string, orgId: string, allowedSubsidiaryIds: ReadonlySet<string> | null) {
  return {
    user: { id: actorId, orgId, roles: [{ key: 'admin', name: 'Admin' }] },
    permissions: new Set(['records.manage_types']),
    allowedSubsidiaryIds,
  }
}

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/records/types/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

async function openedRevision(id: string): Promise<string> {
  const opened = await GET(
    new Request(`http://localhost/api/records/types/${id}`),
    { params: Promise.resolve({ id }) },
  )
  assert.equal(opened.status, 200, await opened.clone().text())
  const token = ((await opened.json()) as { type: { updated_at: string } }).type.updated_at
  assert.match(token, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  return token
}

function fieldsStillDeclareSubsidiary(fields: unknown): boolean {
  return JSON.stringify(fields).includes('subsidiary_id')
}

test(
  'a fenced type PATCH that drops subsidiary_id is refused by name and leaves the field',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeId = randomUUID()
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${`fence-${typeId.slice(0, 8)}`}, 'Fence Type', 'Fence Types',
           ${JSON.stringify(scopedFields)}::jsonb, 'draft', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor }
    })

    state.authz = authz(actorId, org.orgId, new Set([org.subsidiaryId]))
    try {
      await withOrgContext(org.orgId, async () => {
        const token = await openedRevision(typeId)
        const response = await patch(typeId, { fields: unscopeFields, expectedUpdatedAt: token })
        assert.equal(response.status, 422, await response.clone().text())
        const body = (await response.json()) as { error?: string }
        assert.match(body.error ?? '', /subsidiary_id/)
        assert.match(body.error ?? '', /Keep the subsidiary_id field/)
        const stored = (await db.execute<{ fields: unknown }>(sql`
          select fields from custom_record_types where id = ${typeId} and org_id = ${org.orgId}
        `)).rows[0]
        assert.equal(
          fieldsStillDeclareSubsidiary(stored?.fields),
          true,
          'the live definition still declares subsidiary_id',
        )
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'a stale type PATCH refuses with 409 instead of overwriting a newer builder save',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeId = randomUUID()
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${`rev-${typeId.slice(0, 8)}`}, 'Revision Type', 'Revision Types',
           ${JSON.stringify(unscopeFields)}::jsonb, 'draft', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor }
    })

    state.authz = authz(actorId, org.orgId, null)
    try {
      await withOrgContext(org.orgId, async () => {
        const stale = await openedRevision(typeId)

        const first = await patch(typeId, { name: 'Tab A', expectedUpdatedAt: stale })
        assert.equal(first.status, 200, await first.clone().text())
        const afterFirst = ((await first.json()) as { type: { name: string; updated_at: string } }).type
        assert.equal(afterFirst.name, 'Tab A')
        assert.notEqual(afterFirst.updated_at, stale)

        const staleReplay = await patch(typeId, { name: 'Tab B', expectedUpdatedAt: stale })
        assert.equal(staleReplay.status, 409, await staleReplay.clone().text())
        const refused = (await staleReplay.json()) as { error?: string; code?: string }
        assert.equal(refused.code, 'revision_conflict')
        assert.match(refused.error ?? '', /reload/i)

        const live = (await db.execute<{ name: string }>(sql`
          select name from custom_record_types where id = ${typeId} and org_id = ${org.orgId}
        `)).rows[0]
        assert.equal(live?.name, 'Tab A', 'the stale writer must not persist')

        const tokenless = await patch(typeId, { name: 'Autosave' })
        assert.equal(tokenless.status, 409, await tokenless.clone().text())
        const tokenlessBody = (await tokenless.json()) as { error?: string; code?: string }
        assert.equal(tokenlessBody.code, 'revision_conflict')
        assert.match(tokenlessBody.error ?? '', /reload/i)
        const afterTokenless = (await db.execute<{ name: string }>(sql`
          select name from custom_record_types where id = ${typeId} and org_id = ${org.orgId}
        `)).rows[0]
        assert.equal(afterTokenless?.name, 'Tab A', 'a tokenless full-state PATCH must not persist')

        const [winner, loser] = await Promise.all([
          patch(typeId, { name: 'Concurrent A', expectedUpdatedAt: afterFirst.updated_at }),
          patch(typeId, { name: 'Concurrent B', expectedUpdatedAt: afterFirst.updated_at }),
        ])
        const statuses = [winner.status, loser.status].sort()
        assert.deepEqual(statuses, [200, 409])
        const conflict = winner.status === 409 ? winner : loser
        const conflictBody = (await conflict.json()) as { error?: string }
        assert.match(conflictBody.error ?? '', /reload/i)
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'a fenced drop is judged on the locked row so a concurrently added subsidiary_id stays',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeId = randomUUID()
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${`race-${typeId.slice(0, 8)}`}, 'Race Type', 'Race Types',
           ${JSON.stringify(unscopeFields)}::jsonb, 'draft', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor }
    })

    try {
      await withOrgContext(org.orgId, async () => {
        state.authz = authz(actorId, org.orgId, new Set([org.subsidiaryId]))
        const openedWithoutField = await openedRevision(typeId)

        state.authz = authz(actorId, org.orgId, null)
        const added = await patch(typeId, {
          fields: scopedFields,
          expectedUpdatedAt: openedWithoutField,
        })
        assert.equal(added.status, 200, await added.clone().text())
        const afterAdd = ((await added.json()) as { type: { updated_at: string } }).type.updated_at
        assert.notEqual(afterAdd, openedWithoutField)

        state.authz = authz(actorId, org.orgId, new Set([org.subsidiaryId]))
        const tokenlessDrop = await patch(typeId, { fields: unscopeFields })
        assert.equal(tokenlessDrop.status, 409, await tokenlessDrop.clone().text())
        const staleDrop = await patch(typeId, {
          fields: unscopeFields,
          expectedUpdatedAt: openedWithoutField,
        })
        assert.equal(staleDrop.status, 409, await staleDrop.clone().text())
        const currentDrop = await patch(typeId, {
          fields: unscopeFields,
          expectedUpdatedAt: afterAdd,
        })
        assert.equal(currentDrop.status, 422, await currentDrop.clone().text())
        const currentBody = (await currentDrop.json()) as { error?: string }
        assert.match(currentBody.error ?? '', /Keep the subsidiary_id field/)

        const stored = (await db.execute<{ fields: unknown }>(sql`
          select fields from custom_record_types where id = ${typeId} and org_id = ${org.orgId}
        `)).rows[0]
        assert.equal(
          fieldsStillDeclareSubsidiary(stored?.fields),
          true,
          'tokenless or stale drop must not remove a concurrently added subsidiary_id',
        )
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
