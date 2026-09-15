import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.custom-record-draft-scope-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.custom-record-draft-scope-test')]
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
      return { url: 'mock:custom-record-draft-scope-authz', shortCircuit: true }
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
    if (url === 'mock:custom-record-draft-scope-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?custom-record-draft-scope-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts',
)

test(
  'restricted custom-record drafts default subsidiary_id to the only allowed subsidiary',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `draft-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const customTypeId = randomUUID()
      const fields = [{
        id: 'main',
        title: 'Details',
        fields: [
          { id: 'subsidiary_id', type: 'text', label: 'Subsidiary' },
          { id: 'title', type: 'text', label: 'Title' },
        ],
      }]
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${customTypeId}, ${created.orgId}, ${typeKey}, 'Draft Scope', 'Draft Scopes',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor }
    })

    state.authz = {
      user: {
        id: actorId,
        orgId: org.orgId,
        name: 'Scoped Admin',
        roles: [{ key: 'admin', name: 'Admin' }],
      },
      permissions: new Set(['records.create']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    }
    try {
      await withOrgContext(org.orgId, async () => {
        const response = await POST(
          new Request(`http://localhost/api/records/${typeKey}/draft`, { method: 'POST' }),
          { params: Promise.resolve({ typeKey }) },
        )
        assert.equal(response.status, 200)
        const body = await response.json() as { id: string }
        const row = await db.execute<{ data: { subsidiary_id?: string } }>(sql`
          select data from custom_records where id = ${body.id} and org_id = ${org.orgId}
        `)
        assert.equal(row.rows[0]?.data.subsidiary_id, org.subsidiaryId)
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
