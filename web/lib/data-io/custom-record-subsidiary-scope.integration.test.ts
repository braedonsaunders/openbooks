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
    return nextResolve(specifier, context)
  },
})

const { getResource } = await import('./resources.ts')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts',
)

test(
  'restricted custom-record exports omit rows whose JSON subsidiary_id is hidden',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const typeKey = `export-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const { org, hiddenId } = await withBypass(async () => {
      const created = await createScratchOrg()
      const actor = (await seedFlowActors(created.orgId)).adminId
      const branch = randomUUID()
      const typeId = randomUUID()
      const visibleId = randomUUID()
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
          (${branch}, ${created.orgId}, ${created.subsidiaryId}, 'Export Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      await db.execute(sql`
        insert into custom_record_types
          (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
        values
          (${typeId}, ${created.orgId}, ${typeKey}, 'Export Scope', 'Export Scopes',
           ${JSON.stringify(fields)}::jsonb, 'published', ${actor}, ${actor})
      `)
      for (const [id, subsidiaryId, title] of [
        [visibleId, created.subsidiaryId, 'visible'] as const,
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
      return { org: created, hiddenId: hidden }
    })

    try {
      await withOrgContext(org.orgId, async () => {
        const resource = await getResource(org.orgId, `record:${typeKey}`, new Set([org.subsidiaryId]))
        assert.ok(resource)
        const exported = await resource.read({ allowedSubsidiaryIds: new Set([org.subsidiaryId]) })
        assert.equal(exported.rows.length, 1)
        assert.equal(exported.rows[0]?.title, 'visible')
        assert.ok(!exported.rows.some((row) => row.record_number === hiddenId))
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

