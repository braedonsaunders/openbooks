import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.custom-record-revision-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.custom-record-revision-test')]
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
      return { url: 'mock:custom-record-revision-authz', shortCircuit: true }
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
    if (url === 'mock:custom-record-revision-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?custom-record-revision-test'
const { GET, PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)

/**
 * Two tabs editing the same custom record: the second save carries the
 * revision token it read before the first save committed, so it must fail
 * with a 409 instead of silently overwriting the first tab's data bag
 * (same contract as document, payment, prebill-line, and capture edits).
 */
test(
  'a stale custom-record revision refuses instead of overwriting a newer save',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `rev-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const { org, actorId, recordId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const customTypeId = randomUUID()
      const revisionRecordId = randomUUID()
      const fields = [{
        id: 'main',
        title: 'Details',
        fields: [
          { id: 'title', type: 'text', label: 'Title' },
        ],
      }]
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${customTypeId}, ${created.orgId}, ${typeKey}, 'Revision Thing', 'Revision Things',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      await db.execute(sql`
        insert into custom_records
          (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${revisionRecordId}, ${created.orgId}, ${customTypeId}, ${typeKey}, 'REV-000001',
           ${JSON.stringify({ title: 'original' })}::jsonb,
           'rev-000001 original', 'draft', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor, recordId: revisionRecordId }
    })

    state.authz = {
      user: {
        id: actorId,
        orgId: org.orgId,
        roles: [{ key: 'admin', name: 'Admin' }],
      },
      permissions: new Set(['records.create', 'records.read']),
      allowedSubsidiaryIds: null,
    }
    try {
      await withOrgContext(org.orgId, async () => {
        const params = { params: Promise.resolve({ typeKey, id: recordId }) }
        const read = async () => {
          const response = await GET(
            new Request(`http://localhost/api/records/${typeKey}/${recordId}`),
            params,
          )
          assert.equal(response.status, 200)
          return (await response.json() as { record: { data: { title: string }; updated_at: string } }).record
        }
        const save = (body: unknown) => PATCH(
          new Request(`http://localhost/api/records/${typeKey}/${recordId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ typeKey, id: recordId }) },
        )

        // Both tabs read the same revision.
        const stale = (await read()).updated_at
        assert.match(stale, /^\d{1,20}$/)

        // Tab A saves with the fresh token.
        const tabA = await save({ data: { title: 'tab A' }, expectedUpdatedAt: stale })
        assert.equal(tabA.status, 200, await tabA.clone().text())
        const afterA = await read()
        assert.equal(afterA.data.title, 'tab A')
        assert.notEqual(afterA.updated_at, stale)

        // Tab B still holds the pre-A token: it must lose loudly, and the
        // live data must stay exactly what tab A wrote.
        const tabB = await save({ data: { title: 'tab B' }, expectedUpdatedAt: stale })
        assert.equal(tabB.status, 409, await tabB.clone().text())
        assert.equal((await read()).data.title, 'tab A')

        // A data save with no token is rejected before any work happens.
        const tokenless = await save({ data: { title: 'sneaky' } })
        assert.equal(tokenless.status, 409)
        assert.equal((await read()).data.title, 'tab A')

        // A lifecycle-only transition carries no data bag and stays on its
        // status-machine guard (draft -> active requires required fields;
        // use a fresh draft-free assertion: deactivation path is inactive).
        // Here: status-only save without a token must NOT 409 as missing-
        // token — it proceeds to its own domain validation.
        const lifecycle = await save({ status: 'active' })
        assert.notEqual(lifecycle.status, 409, await lifecycle.clone().text())
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
