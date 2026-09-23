import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.record-type-lifecycle-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.record-type-lifecycle-test')]
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
      (specifier === '../../../../../../lib/authz' || specifier === '../../../../../lib/authz') &&
      context.parentURL?.includes('/api/records/')
    ) {
      return { url: 'mock:record-type-lifecycle-authz', shortCircuit: true }
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
    if (url === 'mock:record-type-lifecycle-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const publishUrl = './route.ts?record-type-lifecycle-publish'
const typeUrl = '../route.ts?record-type-lifecycle-type'
const { POST } = (await import(publishUrl)) as typeof import('./route.ts')
const { DELETE } = (await import(typeUrl)) as typeof import('../route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

const publishableFields = [{
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

function lifecycle(id: string, action: 'publish' | 'archive') {
  return POST(
    new Request(`http://localhost/api/records/types/${id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Publish/archive transitions are audited with an operator reason; the
      // route refuses a reasonless transition, so every call carries one.
      body: JSON.stringify({ action, reason: 'lifecycle regression' }),
    }),
    { params: Promise.resolve({ id }) },
  )
}

function lifecycleWithoutReason(id: string, action: 'publish' | 'archive') {
  return POST(
    new Request(`http://localhost/api/records/types/${id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id }) },
  )
}

function remove(id: string) {
  return DELETE(
    new Request(`http://localhost/api/records/types/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  )
}

async function insertDraft(orgId: string, actorId: string, status: 'draft' | 'published' | 'archived' = 'draft') {
  const typeId = randomUUID()
  await db.execute(sql`
    insert into custom_record_types
      (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
    values
      (${typeId}, ${orgId}, ${`life-${typeId.slice(0, 8)}`}, 'Lifecycle Type', 'Lifecycle Types',
       ${JSON.stringify(publishableFields)}::jsonb, ${status}, ${actorId}, ${actorId})
  `)
  return typeId
}

test(
  'a publish without an audit reason is refused before any write',
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
        const draftId = await withBypass(() => insertDraft(org.orgId, actorId))
        const refused = await lifecycleWithoutReason(draftId, 'publish')
        assert.equal(refused.status, 422, await refused.clone().text())
        assert.match(String((await refused.json()).error ?? ''), /reason/i)
        const audits = (await db.execute<{ count: string }>(sql`
          select count(*) from audit_log
           where org_id = ${org.orgId} and table_name = 'custom_record_types' and row_id = ${draftId}
        `)).rows[0]
        assert.equal(audits?.count, '0', 'the refusal commits no audit event')
        const stillThere = (await db.execute<{ status: string }>(sql`
          select status from custom_record_types where id = ${draftId} and org_id = ${org.orgId}
        `)).rows[0]
        assert.equal(stillThere?.status, 'draft', 'the refusal changes no status')
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'a publish commits its transition audit with before, after and reason',
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
        const draftId = await withBypass(() => insertDraft(org.orgId, actorId))
        const published = await lifecycle(draftId, 'publish')
        assert.equal(published.status, 200, await published.clone().text())
        const events = (await db.execute<{ action: string; changes: unknown; actor_id: string }>(sql`
          select action, changes, actor_id from audit_log
           where org_id = ${org.orgId} and table_name = 'custom_record_types' and row_id = ${draftId}
           order by id
        `)).rows
        assert.equal(events.length, 1, 'one transition event per publish')
        assert.equal(events[0]!.action, 'update')
        assert.equal(events[0]!.actor_id, actorId)
        const changes = events[0]!.changes as { before: { status: string }; after: { status: string }; reason: string }
        assert.equal(changes.before.status, 'draft')
        assert.equal(changes.after.status, 'published')
        assert.equal(changes.reason, 'lifecycle regression')
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'publish and delete refuse zero-row writes by name instead of reporting success',
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
        const publishedId = await withBypass(() => insertDraft(org.orgId, actorId))
        const published = await lifecycle(publishedId, 'publish')
        assert.equal(published.status, 200, await published.clone().text())
        assert.deepEqual(await published.json(), { ok: true, status: 'published' })

        const deletePublished = await remove(publishedId)
        assert.equal(deletePublished.status, 422, await deletePublished.clone().text())
        const deleteBody = (await deletePublished.json()) as { error?: string; ok?: unknown }
        assert.equal(deleteBody.ok, undefined)
        assert.match(deleteBody.error ?? '', /Only draft types can be deleted/)
        const stillThere = (await db.execute(sql`
          select status from custom_record_types where id = ${publishedId} and org_id = ${org.orgId}
        `)).rows[0] as { status: string } | undefined
        assert.equal(stillThere?.status, 'published')

        const goneId = await withBypass(() => insertDraft(org.orgId, actorId))
        const deleted = await remove(goneId)
        assert.equal(deleted.status, 200, await deleted.clone().text())
        const publishGone = await lifecycle(goneId, 'publish')
        assert.equal(publishGone.status, 404, await publishGone.clone().text())
        const goneBody = (await publishGone.json()) as { error?: string; ok?: unknown }
        assert.equal(goneBody.ok, undefined)
        assert.equal(goneBody.error, 'not found')

        const draftId = await withBypass(() => insertDraft(org.orgId, actorId))
        const archiveDraft = await lifecycle(draftId, 'archive')
        assert.equal(archiveDraft.status, 422, await archiveDraft.clone().text())
        const archiveBody = (await archiveDraft.json()) as { error?: string; ok?: unknown }
        assert.equal(archiveBody.ok, undefined)
        assert.match(archiveBody.error ?? '', /Only published types can be archived/)

        const raceId = await withBypass(() => insertDraft(org.orgId, actorId))
        const [first, second] = await Promise.all([
          lifecycle(raceId, 'publish'),
          remove(raceId),
        ])
        const okCount = [first, second].filter((response) => response.status === 200).length
        assert.equal(okCount, 1, `${first.status}/${second.status} must not both claim success`)
        const loser = first.status === 200 ? second : first
        assert.ok(loser.status === 404 || loser.status === 422, await loser.clone().text())
        const loserBody = (await loser.json()) as { ok?: unknown; error?: string }
        assert.equal(loserBody.ok, undefined)
        assert.ok(loserBody.error, 'the zero-row loser names the refusal')
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
