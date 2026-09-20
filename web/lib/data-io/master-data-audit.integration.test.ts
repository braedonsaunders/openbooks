import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Master-data imports evidence every row with only { source: 'import' } —
// no before-image on updates, no after-image at all. An import that rewrites
// a master row must carry the same before/after evidence as the setup import
// resource.
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
const { MASTER_BY_KEY, masterResource } = await import('./master-data-resources.ts')

test(
  'a committed master-data import evidences before and after on every row',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
    try {
      const resource = masterResource(MASTER_BY_KEY.get('items')!, org.orgId)
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
          }>(sql`
            select action, actor_id, changes from audit_log
             where org_id = ${org.orgId} and table_name = 'items'
             order by at, id
          `)
        ).rows

      await withOrgContext(org.orgId, async () => {
        const first = await resource.write(
          [{ code: 'AUD-1', name: 'Audit item', kind: 'service' }],
          'upsert',
          ctx,
        )
        assert.equal(first.created, 1, JSON.stringify(first.errors))
        {
          const rows = await auditRows()
          assert.equal(rows.length, 1)
          assert.equal(rows[0]!.action, 'insert')
          assert.equal(rows[0]!.actor_id, actorId)
          const changes = rows[0]!.changes as { source: string; after: { name: string } }
          assert.equal(changes.source, 'import')
          assert.equal(changes.after.name, 'Audit item')
        }

        const second = await resource.write(
          [{ code: 'AUD-1', name: 'Audit item v2', kind: 'service' }],
          'upsert',
          ctx,
        )
        assert.equal(second.updated, 1, JSON.stringify(second.errors))
        {
          const rows = await auditRows()
          assert.equal(rows.length, 2)
          assert.equal(rows[1]!.action, 'update')
          assert.equal(rows[1]!.actor_id, actorId)
          const changes = rows[1]!.changes as {
            source: string
            before: { name: string }
            after: { name: string }
          }
          assert.equal(changes.source, 'import')
          assert.equal(changes.before.name, 'Audit item')
          assert.equal(changes.after.name, 'Audit item v2')
        }
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
