import { sql } from 'drizzle-orm'
import { db, withOrgContext, withOrgTransaction } from '../platform/db.ts'
import { isUuid } from '../platform/uuid.ts'
import { actorHasPermission } from '../organization/actor-permissions.ts'
import { actorAllowedSubsidiaryIds } from '../organization/actor-subsidiaries.ts'
import { buildSource, getConnection } from './connection.ts'
import { claimSyncRun } from './sync.ts'
import { syncSourcePartyPhotos } from './party-photos.ts'

/** A scoped operational import uses the same adapter and photo command as migration/mirroring. */
export async function importNetSuiteEmployeePhotos(options: {
  orgId: string; connectionId: string; actorId: string
  execute: boolean; employeeRefs?: readonly string[]
}) {
  for (const id of [options.orgId, options.connectionId, options.actorId]) {
    if (!isUuid(id)) throw new Error('Employee photo imports require organization, connection and actor UUIDs')
  }
  return withOrgContext(options.orgId, async () => {
    const connection = await withOrgTransaction(options.orgId, async () => {
      for (const permission of ['sync.run', 'parties.read', 'parties.manage']) {
        if (!await actorHasPermission(db, options.orgId, options.actorId, permission)) throw new Error(`Employee photo imports require ${permission}`)
      }
      if (await actorAllowedSubsidiaryIds(db, options.orgId, options.actorId) !== null) throw new Error('Employee photo imports require unrestricted subsidiary access')
      const found = await getConnection(options.orgId, options.connectionId)
      if (!found || found.source !== 'netsuite') throw new Error('The NetSuite connection does not belong to this organization')
      return found
    }, { readOnly: true })
    const source = buildSource(connection)
    const runId = options.execute ? (await claimSyncRun({
      orgId: options.orgId, connectionId: options.connectionId, sourceName: 'netsuite',
      kind: 'attachments', triggeredBy: options.actorId,
    }))[0].id : null
    try {
      const summary = await syncSourcePartyPhotos(source, { ...options, runId })
      if (runId) {
        const failed = summary.errors + summary.unmatched
        const saved = await db.execute(sql`
          update sync_runs set status=${failed ? 'failed' : 'ok'}, finished_at=now(),
            stats=${JSON.stringify({ employeePhotos: summary })}::jsonb,
            error_message=${failed ? `${summary.errors} photo errors; ${summary.unmatched} unmatched source employee identities` : null}
          where org_id=${options.orgId} and id=${runId} returning id`)
        if (saved.rows.length !== 1) throw new Error('Employee photo import completion did not persist')
      }
      return { runId, ...summary }
    } catch (error) {
      if (runId) {
        const saved = await db.execute(sql`
          update sync_runs set status='failed', finished_at=now(), error_message=${(error instanceof Error ? error.message : 'Employee photo import failed').slice(0, 2000)}
          where org_id=${options.orgId} and id=${runId} returning id`)
        if (saved.rows.length !== 1) throw new Error('Employee photo import failure did not persist', { cause: error })
      }
      throw error
    }
  })
}
