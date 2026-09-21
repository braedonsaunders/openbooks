import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.record-type-view-scope-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.record-type-view-scope-test')]
  export async function requirePermission() {
    if (!state.authz) throw new Error('unauthorized')
    return state.authz
  }
`
const mockIntl = `
  export async function getTranslations() { return (key) => key }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '../../../../lib/authz' && context.parentURL?.includes('/records/types/')) {
      return { url: 'mock:record-type-view-scope-authz', shortCircuit: true }
    }
    if (specifier === 'next-intl/server') {
      return { url: 'mock:record-type-view-scope-intl', shortCircuit: true }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf('/web/') + 5)
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context)
    }
    if (context.parentURL?.startsWith('mock:')) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url })
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:record-type-view-scope-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    if (url === 'mock:record-type-view-scope-intl') {
      return { format: 'module', source: mockIntl, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const viewUrl = './view.ts?record-type-view-scope-test'
const { loadRecordTypes } = (await import(viewUrl)) as typeof import('./view.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)

function typeAuthz(actorId: string, orgId: string, allowedSubsidiaryIds: ReadonlySet<string> | null) {
  return {
    user: { id: actorId, orgId, roles: [{ key: 'admin', name: 'Admin' }] },
    permissions: new Set(['records.manage_types']),
    allowedSubsidiaryIds,
  }
}

test(
  'record-type workspace record counts hide rows whose JSON subsidiary_id is outside the caller fence',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const scopedKey = `viewcount-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branch = randomUUID()
      const typeId = randomUUID()
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
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Type View Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${scopedKey}, 'Type View Scoped', 'Type View Scoped',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      for (const [subsidiaryId, title] of [
        [created.subsidiaryId, 'visible'] as const,
        [branch, 'hidden'] as const,
      ]) {
        await db.execute(sql`
          insert into custom_records
            (org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
          values
            (${created.orgId}, ${typeId}, ${scopedKey}, ${randomUUID()},
             ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
             ${title}, 'active', ${actor}, ${actor})
        `)
      }
      return { org: created, actorId: actor }
    })

    state.authz = typeAuthz(actorId, org.orgId, new Set([org.subsidiaryId]))
    try {
      await withOrgContext(org.orgId, async () => {
        const data = await loadRecordTypes({})
        const row = data.rows.find((item) => item.key === scopedKey)
        assert.equal(row?.recordCount, '1')
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'record-type workspace record counts still hide JSON subsidiary_id rows after the type drops the field',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const droppedKey = `viewtdrop-${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branch = randomUUID()
      const typeId = randomUUID()
      const fields = [{
        id: 'main',
        title: 'Details',
        fields: [{ id: 'title', type: 'text', label: 'Title' }],
      }]
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Type View Dropped Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${droppedKey}, 'Type View Dropped', 'Type View Dropped',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      for (const [subsidiaryId, title] of [
        [created.subsidiaryId, 'visible'] as const,
        [branch, 'hidden'] as const,
      ]) {
        await db.execute(sql`
          insert into custom_records
            (org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
          values
            (${created.orgId}, ${typeId}, ${droppedKey}, ${randomUUID()},
             ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
             ${title}, 'active', ${actor}, ${actor})
        `)
      }
      return { org: created, actorId: actor }
    })

    state.authz = typeAuthz(actorId, org.orgId, new Set([org.subsidiaryId]))
    try {
      await withOrgContext(org.orgId, async () => {
        const data = await loadRecordTypes({})
        const row = data.rows.find((item) => item.key === droppedKey)
        assert.equal(row?.recordCount, '1', 'dropping subsidiary_id must not unscope stored JSON rows')
      })
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
