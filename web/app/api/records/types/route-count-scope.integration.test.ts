import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.record-type-count-scope-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockAuthz = `
  import { NextResponse } from 'next/server';
  const state = globalThis[Symbol.for('openbooks.record-type-count-scope-test')]
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
    if (specifier === '../../../../lib/authz' && context.parentURL?.includes('/api/records/')) {
      return { url: 'mock:record-type-count-scope-authz', shortCircuit: true }
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
    if (url === 'mock:record-type-count-scope-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?record-type-count-scope-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts',
)

test(
  'record-type record_count hides rows whose JSON subsidiary_id is outside the caller fence',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const scopedKey = `typecount-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const plainKey = `typeplain-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const { org, actorId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branch = randomUUID()
      const scopedTypeId = randomUUID()
      const plainTypeId = randomUUID()
      const scopedFields = [{
        id: 'main',
        title: 'Details',
        fields: [
          { id: 'subsidiary_id', type: 'text', label: 'Subsidiary' },
          { id: 'title', type: 'text', label: 'Title' },
        ],
      }]
      const plainFields = [{
        id: 'main',
        title: 'Details',
        fields: [{ id: 'title', type: 'text', label: 'Title' }],
      }]
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Count Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      for (const [typeId, key, name, fields] of [
        [scopedTypeId, scopedKey, 'Count Scoped', scopedFields],
        [plainTypeId, plainKey, 'Count Plain', plainFields],
      ] as const) {
        await db.execute(sql`
          insert into custom_record_types
            (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
          values
            (${typeId}, ${created.orgId}, ${key}, ${name}, ${name},
             ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
        `)
      }
      for (const [subsidiaryId, title] of [
        [created.subsidiaryId, 'visible'] as const,
        [branch, 'hidden'] as const,
      ]) {
        await db.execute(sql`
          insert into custom_records
            (org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
          values
            (${created.orgId}, ${scopedTypeId}, ${scopedKey}, ${randomUUID()},
             ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
             ${title}, 'active', ${actor}, ${actor})
        `)
      }
      await db.execute(sql`
        insert into custom_records
          (org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
        values
          (${created.orgId}, ${plainTypeId}, ${plainKey}, ${randomUUID()},
           ${JSON.stringify({ title: 'plain' })}::jsonb,
           'plain', 'active', ${actor}, ${actor})
      `)
      return { org: created, actorId: actor }
    })

    try {
      const countsFor = async (allowedSubsidiaryIds: ReadonlySet<string> | null) => {
        state.authz = {
          user: { id: actorId, orgId: org.orgId, roles: [{ key: 'admin', name: 'Admin' }] },
          permissions: new Set(['records.manage_types']),
          allowedSubsidiaryIds,
        }
        const response = await withOrgContext(org.orgId, () => GET())
        assert.equal(response.status, 200)
        const body = (await response.json()) as { types: Array<{ key: string; record_count: string | number }> }
        return new Map(body.types.map((t) => [t.key, Number(t.record_count)]))
      }

      // Restricted to the root entity: the scoped type counts only the
      // visible row; the field-less type stays org-visible.
      assert.deepEqual(
        [...(await countsFor(new Set([org.subsidiaryId]))).entries()].sort(),
        [[plainKey, 1], [scopedKey, 1]].sort(),
      )
      // Empty fence fails closed; unrestricted callers keep true totals.
      assert.equal((await countsFor(new Set())).get(scopedKey), 0)
      assert.deepEqual(
        [...(await countsFor(null)).entries()].sort(),
        [[plainKey, 1], [scopedKey, 2]].sort(),
      )
    } finally {
      state.authz = null
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
