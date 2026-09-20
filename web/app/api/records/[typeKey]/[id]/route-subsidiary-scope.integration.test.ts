import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.custom-record-detail-scope-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.custom-record-detail-scope-test')]
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
      (specifier === '../../../../../lib/authz' || specifier === '../../../../lib/authz') &&
      context.parentURL?.includes('/api/records/')
    ) {
      return { url: 'mock:custom-record-detail-scope-authz', shortCircuit: true }
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
    if (url === 'mock:custom-record-detail-scope-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?custom-record-detail-scope-test'
const { GET, PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
const { GET: LIST } = (await import('../route.ts?custom-record-detail-scope-list')) as typeof import('../route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)

test(
  'custom-record detail route hides a row whose JSON subsidiary_id is outside scope',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `detail-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const { org, actorId, recordId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branch = randomUUID()
      const customTypeId = randomUUID()
      const hiddenRecordId = randomUUID()
      const fields = [{
        id: 'main',
        title: 'Details',
        fields: [
          { id: 'subsidiary_id', type: 'text', label: 'Subsidiary' },
          { id: 'title', type: 'text', label: 'Title' },
        ],
      }]
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Detail Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${customTypeId}, ${created.orgId}, ${typeKey}, 'Detail Scope', 'Detail Scopes',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      await db.execute(sql`
        insert into custom_records
          (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${hiddenRecordId}, ${created.orgId}, ${customTypeId}, ${typeKey}, ${randomUUID()},
           ${JSON.stringify({ subsidiary_id: branch, title: 'hidden' })}::jsonb,
           'hidden', 'active', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor, recordId: hiddenRecordId }
    })

    state.authz = {
      user: {
        id: actorId,
        orgId: org.orgId,
        roles: [{ key: 'admin', name: 'Admin' }],
      },
      permissions: new Set(['records.read']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    }
    try {
      await withOrgContext(org.orgId, async () => {
        const response = await GET(
          new Request(`http://localhost/api/records/${typeKey}/${recordId}`),
          { params: Promise.resolve({ typeKey, id: recordId }) },
        )
        assert.equal(response.status, 404)
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'custom-record detail still hides a JSON subsidiary_id row after the type drops the field',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `dropd-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const { org, actorId, recordId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branch = randomUUID()
      const customTypeId = randomUUID()
      const hiddenRecordId = randomUUID()
      const fields = [{
        id: 'main',
        title: 'Details',
        fields: [{ id: 'title', type: 'text', label: 'Title' }],
      }]
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Dropped Detail Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${customTypeId}, ${created.orgId}, ${typeKey}, 'Dropped Detail', 'Dropped Details',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      await db.execute(sql`
        insert into custom_records
          (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${hiddenRecordId}, ${created.orgId}, ${customTypeId}, ${typeKey}, ${randomUUID()},
           ${JSON.stringify({ subsidiary_id: branch, title: 'hidden' })}::jsonb,
           'hidden', 'active', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor, recordId: hiddenRecordId }
    })

    state.authz = {
      user: {
        id: actorId,
        orgId: org.orgId,
        roles: [{ key: 'admin', name: 'Admin' }],
      },
      permissions: new Set(['records.read']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    }
    try {
      await withOrgContext(org.orgId, async () => {
        const response = await GET(
          new Request(`http://localhost/api/records/${typeKey}/${recordId}`),
          { params: Promise.resolve({ typeKey, id: recordId }) },
        )
        assert.equal(response.status, 404)
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'interactive PATCH after field-drop keeps stored subsidiary_id so the other fence cannot list/get it',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `patchdrop-${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const visibleId = randomUUID()
    const { org, actorId, branch } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const other = randomUUID()
      const customTypeId = randomUUID()
      const fields = [{
        id: 'main',
        title: 'Details',
        fields: [{ id: 'title', type: 'text', label: 'Title' }],
      }]
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${other}, ${created.orgId}, ${created.subsidiaryId}, 'Patch Drop Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${customTypeId}, ${created.orgId}, ${typeKey}, 'Patch Dropped', 'Patch Dropped',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      await db.execute(sql`
        insert into custom_records
          (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${visibleId}, ${created.orgId}, ${customTypeId}, ${typeKey}, ${visibleId},
           ${JSON.stringify({ subsidiary_id: created.subsidiaryId, title: 'visible' })}::jsonb,
           'visible', 'active', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor, branch: other }
    })

    const homeAuthz = {
      user: {
        id: actorId,
        orgId: org.orgId,
        roles: [{ key: 'admin', name: 'Admin' }],
      },
      permissions: new Set(['records.read', 'records.create']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    }
    const otherAuthz = { ...homeAuthz, allowedSubsidiaryIds: new Set([branch]) }

    try {
      await withOrgContext(org.orgId, async () => {
        state.authz = homeAuthz
        const params = { params: Promise.resolve({ typeKey, id: visibleId }) }
        const opened = await GET(
          new Request(`http://localhost/api/records/${typeKey}/${visibleId}`),
          params,
        )
        assert.equal(opened.status, 200, await opened.clone().text())
        const revision = ((await opened.json()) as { record: { updated_at: string } }).record.updated_at

        const saved = await PATCH(
          new Request(`http://localhost/api/records/${typeKey}/${visibleId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: { title: 'kept' }, expectedUpdatedAt: revision }),
          }),
          params,
        )
        assert.equal(saved.status, 200, await saved.clone().text())
        const stored = (await db.execute<{ title: string; subsidiary_id: string | null }>(sql`
          select data ->> 'title' as title, data ->> 'subsidiary_id' as subsidiary_id
            from custom_records where id = ${visibleId}
        `)).rows[0]
        assert.equal(stored?.title, 'kept')
        assert.equal(
          stored?.subsidiary_id,
          org.subsidiaryId,
          'interactive PATCH after field-drop must not erase the stored JSON subsidiary_id',
        )

        state.authz = otherAuthz
        const listed = await LIST(
          new Request(`http://localhost/api/records/${typeKey}`),
          { params: Promise.resolve({ typeKey }) },
        )
        assert.equal(listed.status, 200, await listed.clone().text())
        const body = (await listed.json()) as { records: Array<{ id: string }>; total: number }
        assert.equal(body.records.some((row) => row.id === visibleId), false)
        const got = await GET(
          new Request(`http://localhost/api/records/${typeKey}/${visibleId}`),
          params,
        )
        assert.equal(got.status, 404)
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
