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
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts',
)

test(
  'restricted platform custom-record reads and writes honor subsidiary_id in JSON data',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `scoped-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const { org, actorId, branchId, visibleId, hiddenId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branch = randomUUID()
      const typeId = randomUUID()
      const visible = randomUUID()
      const hidden = randomUUID()
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
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Branch Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${typeKey}, 'Scoped Record', 'Scoped Records',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      for (const [id, subsidiaryId, title] of [
        [visible, created.subsidiaryId, 'visible'] as const,
        [hidden, branch, 'hidden'] as const,
      ]) {
        await db.execute(sql`
          insert into custom_records
            (id, org_id, type_id, type_key, record_number, data, search_text, status, created_by, updated_by)
          values
            (${id}, ${created.orgId}, ${typeId}, ${typeKey}, ${id},
             ${JSON.stringify({ subsidiary_id: subsidiaryId, title })}::jsonb,
             ${title}, 'active', ${actor}, ${actor})
        `)
      }
      return { org: created, actorId: actor, branchId: branch, visibleId: visible, hiddenId: hidden }
    })

    const user = {
      id: actorId,
      email: 'platform-scope@scratch.test',
      name: 'Platform Scope Controller',
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
      grantedPermissions: ['records.read', 'records.create'],
      userCan: () => true,
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    })

    try {
      await withOrgContext(org.orgId, async () => {
        const listed = await platform.list(typeKey, {}) as {
          records: Array<{ id: string; data: { subsidiary_id: string } }>
          total: number
        }
        assert.equal(listed.total, 1)
        assert.equal(listed.records[0]?.id, visibleId)
        assert.equal(listed.records[0]?.data.subsidiary_id, org.subsidiaryId)

        assert.equal((await platform.get(typeKey, visibleId) as { id: string }).id, visibleId)
        assert.equal(await platform.get(typeKey, hiddenId), null)

        await assert.rejects(
          platform.create(typeKey, { data: { subsidiary_id: branchId, title: 'smuggled' } }),
          /outside the caller subsidiary scope/,
        )
        await assert.rejects(
          platform.update(typeKey, hiddenId, { data: { title: 'smuggled' } }),
          /outside the caller subsidiary scope/,
        )
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
