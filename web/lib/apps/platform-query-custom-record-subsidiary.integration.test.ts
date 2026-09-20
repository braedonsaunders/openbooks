import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const { createAppPlatformAdapter } = await import('./platform.ts')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)

test(
  'restricted platform queries omit custom-record rows whose JSON subsidiary_id is hidden',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `query-${randomUUID().replaceAll('-', '').slice(0, 12)}`
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
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Query Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${typeKey}, 'Query Scope', 'Query Scopes',
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
            (${created.orgId}, ${typeId}, ${typeKey}, ${randomUUID()},
             ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
             ${title}, 'active', ${actor}, ${actor})
        `)
      }
      return { org: created, actorId: actor }
    })

    const user = {
      id: actorId,
      email: 'platform-query-scope@scratch.test',
      name: 'Platform Query Scope Controller',
      roles: [{ key: 'admin', name: 'Admin' }],
      orgId: org.orgId,
      envKind: 'production' as const,
      productionOrgId: org.orgId,
      isSuperAdmin: false,
      homeUserId: actorId,
      homeOrgId: org.orgId,
    }
    const platform = createAppPlatformAdapter({
      orgId: org.orgId,
      user,
      grantedPermissions: ['records.read'],
      userCan: () => true,
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    })

    try {
      await withOrgContext(org.orgId, async () => {
        const result = await platform.query!({
          from: { type: typeKey, as: 'r' },
          select: [{ source: 'r', field: 'title' }],
          sorts: [{ column: 'r.title', direction: 'asc' }],
        }) as { records: Array<{ 'r.title': string }> }
        assert.deepEqual(result.records, [{ 'r.title': 'visible' }])
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
