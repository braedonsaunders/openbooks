import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { FormSection } from '@openbooks/forms-core'

// Committed custom-record imports overwrite live data bags with no
// audit_log evidence — only the import_jobs run row records the batch.
// Every updated or created row must carry its own actor + before/after
// evidence (same source:'import' shape as the setup import resource).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts'
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
  'a committed custom-record import evidences every created and updated row',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
    const typeKey = `impaudit-${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const typeId = randomUUID()
    try {
      await withBypass(() =>
        db.execute(sql`
          insert into custom_record_types
            (id, org_id, key, name, plural_name, fields, status, created_by, updated_by)
          values
            (${typeId}, ${org.orgId}, ${typeKey}, 'Import Audit', 'Import Audits',
             ${JSON.stringify(sections)}::jsonb, 'published', ${actorId}, ${actorId})
        `),
      )
      const resource = recordResource(org.orgId, typeKey, sections, 'Import Audit')
      const ctx = {
        orgId: org.orgId,
        actorId,
        dryRun: false,
        allowedSubsidiaryIds: null,
      }
      const auditRows = async () =>
        (
          await db.execute<{
            action: string
            actor_id: string | null
            changes: Record<string, unknown>
            row_id: string
          }>(sql`
            select action, actor_id, changes, row_id from audit_log
             where org_id = ${org.orgId} and table_name = 'custom_records'
             order by at, id
          `)
        ).rows

      await withOrgContext(org.orgId, async () => {
        // A dry run writes nothing and evidences nothing.
        const preview = await resource.write([{ title: 'preview only' }], 'upsert', { ...ctx, dryRun: true })
        assert.equal(preview.created, 1)
        assert.deepEqual(await auditRows(), [])

        // A committed create evidences the after-image with the actor.
        const first = await resource.write([{ title: 'imported' }], 'upsert', ctx)
        assert.equal(first.created, 1)
        const number = (
          await db.execute<{ record_number: string }>(sql`
            select record_number from custom_records
             where org_id = ${org.orgId} and type_key = ${typeKey}`)
        ).rows[0]!.record_number
        {
          const rows = await auditRows()
          assert.equal(rows.length, 1)
          assert.equal(rows[0]!.action, 'insert')
          assert.equal(rows[0]!.actor_id, actorId)
          const changes = rows[0]!.changes as { source: string; after: { data: { title: string } } }
          assert.equal(changes.source, 'import')
          assert.equal(changes.after.data.title, 'imported')
        }

        // A committed update evidences before and after with the actor.
        const second = await resource.write(
          [{ record_number: number, title: 'imported v2' }],
          'upsert',
          ctx,
        )
        assert.equal(second.updated, 1)
        {
          const rows = await auditRows()
          assert.equal(rows.length, 2)
          assert.equal(rows[1]!.action, 'update')
          assert.equal(rows[1]!.actor_id, actorId)
          const changes = rows[1]!.changes as {
            source: string
            before: { data: { title: string } }
            after: { data: { title: string } }
          }
          assert.equal(changes.source, 'import')
          assert.equal(changes.before.data.title, 'imported')
          assert.equal(changes.after.data.title, 'imported v2')
        }
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
