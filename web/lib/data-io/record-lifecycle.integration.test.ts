import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { FormSection } from '@openbooks/forms-core'

// Bulk custom-record import must never move lifecycle: an export carries a
// status column, but status changes belong to the native record PATCH with
// its audited reason. An export→reimport round-trip of an inactive record
// must update its data and leave it inactive.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { recordResource } = await import('./record-resources.ts')

const sections: FormSection[] = [
  {
    id: 'main',
    title: 'Details',
    fields: [{ id: 'title', label: 'Title', type: 'text' }],
  },
] as unknown as FormSection[]

test(
  'export then reimport keeps an inactive custom record inactive',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
    const typeKey = `lifecycle-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const typeId = randomUUID()
    try {
      await withBypass(() =>
        db.execute(sql`
          insert into custom_record_types
            (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
          values
            (${typeId}, ${org.orgId}, ${typeKey}, 'Lifecycle', 'Lifecycles',
             ${JSON.stringify(sections)}::jsonb, 'published', ${actorId}, ${actorId})
        `),
      )
      await withBypass(() =>
        db.execute(sql`
          insert into custom_records
            (org_id, type_id, type_key, record_number, data, search_text, status, created_by)
          values
            (${org.orgId}, ${typeId}, ${typeKey}, 'LC-1',
             ${JSON.stringify({ title: 'before' })}::jsonb, 'before', 'inactive', ${actorId})
        `),
      )
      const resource = recordResource(org.orgId, typeKey, sections, 'Lifecycles')
      const ctx = {
        orgId: org.orgId,
        actorId,
        dryRun: false,
        allowedSubsidiaryIds: null,
      }
      await withOrgContext(org.orgId, async () => {
        const exported = await resource.read()
        const row = exported.rows.find((r) => String(r.record_number) === 'LC-1')
        assert.ok(row, 'export must include the inactive record')
        assert.equal(String(row.status), 'inactive')

        const outcome = await resource.write(
          [{ record_number: 'LC-1', title: 'after', status: 'inactive' }],
          'upsert',
          ctx,
        )
        assert.equal(outcome.failed, 0)
        assert.equal(outcome.updated, 1)

        const stored = (
          await db.execute<{ status: string; data: { title: string } }>(sql`
            select status, data from custom_records
             where org_id = ${org.orgId} and type_key = ${typeKey} and record_number = 'LC-1'
          `)
        ).rows[0]!
        assert.equal(stored.data.title, 'after')
        assert.equal(stored.status, 'inactive')
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
