import { sql } from 'drizzle-orm'
import { db, withOrgContext, withOrgTransaction } from '../platform/db.ts'
import { isUuid } from '../platform/uuid.ts'
import { actorHasPermission } from '../organization/actor-permissions.ts'
import { actorAllowedSubsidiaryIds } from '../organization/actor-subsidiaries.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { buildSource, getConnection } from './connection.ts'
import { claimSyncRun } from './sync.ts'
import { loadEntities } from './migrate.ts'

/** Refresh selected source employee identities and roles through the normal master-data loader. */
export async function refreshNetSuiteEmployees(input: {
  orgId: string; connectionId: string; actorId: string; employeeRefs: readonly string[]; execute: boolean
}) {
  if ([input.orgId, input.connectionId, input.actorId].some(id => !isUuid(id))) throw new Error('Organization, connection and actor UUIDs are required')
  if (!input.employeeRefs.length || new Set(input.employeeRefs).size !== input.employeeRefs.length) throw new Error('Provide distinct source employee IDs')
  return withOrgContext(input.orgId, async () => {
    const connection = await withOrgTransaction(input.orgId, async () => {
      if (!await actorHasPermission(db, input.orgId, input.actorId, 'sync.run')
        || !await actorHasPermission(db, input.orgId, input.actorId, 'parties.manage')
        || await actorAllowedSubsidiaryIds(db, input.orgId, input.actorId) !== null) throw new Error('Employee source refresh requires sync.run, parties.manage and unrestricted subsidiary access')
      const row = await getConnection(input.orgId, input.connectionId)
      if (!row || row.source !== 'netsuite') throw new Error('The NetSuite connection does not belong to this organization')
      return row
    }, { readOnly: true })
    const source = buildSource(connection)
    if (!source.employeeEntities) throw new Error('The connector does not support scoped employee source refresh')
    if (!source.partyPhotos) throw new Error('The connector cannot verify its source account')
    await source.partyPhotos() // Verify the authenticated source account before adopting its identities.
    const streams = await source.employeeEntities(input.employeeRefs)
    async function snapshot() {
      return (await db.execute(sql`
        select p.id,p.display_name,p.is_active,p.subsidiary_id,p.custom,e.id as employee_role_id,
          e.is_active as employee_role_active,e.hired_on,e.terminated_on,e.department_id,e.supervisor_id
        from parties p left join employee_roles e on e.org_id=p.org_id and e.party_id=p.id
        where p.org_id=${input.orgId} and p.custom->>${source.refKey} in (${sql.join(input.employeeRefs.map(ref => sql`${ref}`),sql`, `)})
        order by p.id`)).rows
    }
    const plan = await withOrgTransaction(input.orgId, async () => {
      for (const record of streams.flatMap(stream => stream.records)) {
        const subsidiaryRef = record.fields.subsidiaryRef
        const subsidiaries = (await db.execute(sql`select id from subsidiaries where org_id=${input.orgId}
          and custom->>${source.refKey}=${String(subsidiaryRef ?? '')} and is_active and not is_elimination`)).rows
        if (subsidiaries.length !== 1) throw new Error(`Employee ${record.sourceRef} requires one active native subsidiary mapped to source ${String(subsidiaryRef ?? 'missing')}`)
        const role = record.fields.employeeRole as Record<string, unknown>
        for (const [table, ref] of [['departments', role.departmentRef], ['parties', role.supervisorRef]] as const) {
          if (ref == null) continue
          const rows = (await db.execute(sql`select id from ${sql.raw(table)} where org_id=${input.orgId} and custom->>${source.refKey}=${String(ref)}`)).rows
          if (rows.length !== 1) throw new Error(`Employee ${record.sourceRef} requires one native ${table} mapping for source ${String(ref)}`)
        }
        const identities = (await db.execute(sql`select id from parties where org_id=${input.orgId} and custom->>${source.refKey}=${record.sourceRef}`)).rows
        if (identities.length > 1) throw new Error(`Employee ${record.sourceRef} has ambiguous native identity mappings`)
      }
      return { source: streams.flatMap(stream => stream.records), before: await snapshot() }
    }, { readOnly: true })
    if (!input.execute) return { runId: null, ...plan }
    const runId = (await claimSyncRun({ ...input, sourceName: source.name, triggeredBy: input.actorId, kind: 'targeted_repair' }))[0].id
    try {
      const result = await withOrgTransaction(input.orgId, async () => {
        const scope = await lockActorCommandAuthority(db, input.orgId, input.actorId, null, 'sync.run')
        if (scope !== null || !await actorHasPermission(db, input.orgId, input.actorId, 'parties.manage')) throw new Error('Employee source refresh authority changed')
        await db.execute(sql`select id from parties where org_id=${input.orgId}
          and custom->>${source.refKey} in (${sql.join(input.employeeRefs.map(ref => sql`${ref}`),sql`, `)}) order by id for update`)
        const before = await snapshot()
        if (JSON.stringify(before) !== JSON.stringify(plan.before)) throw new Error('The employee source mapping or role changed after preparation; prepare again')
        const stats = await loadEntities(source,input.orgId,null,undefined,
          { connectionId: input.connectionId, runId, actorId: input.actorId, sourceName: source.name }, streams, undefined, { employeeRefs: input.employeeRefs })
        if (Object.values(stats).some(row => row.failed)) throw new Error(`Native employee source refresh refused: ${JSON.stringify(stats)}`)
        const after = await snapshot()
        if (after.length !== input.employeeRefs.length || after.some(row => !row.employee_role_id)) throw new Error('Native employee role readback is incomplete')
        const audit = await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,request_id,changes)
          values(${input.orgId},'connections',${input.connectionId},'update',${input.actorId},${runId},
            ${JSON.stringify({ mode: 'employee_source_refresh', source: source.name, sourceRefs: input.employeeRefs, before, after })}::jsonb) returning id`)
        if (audit.rows.length !== 1) throw new Error('Employee source refresh audit did not persist')
        return { ...plan, after, stats }
      })
      const saved = await db.execute(sql`update sync_runs set status='ok',finished_at=now(),stats=${JSON.stringify(result.stats)}::jsonb
        where org_id=${input.orgId} and id=${runId} returning id`)
      if (saved.rows.length !== 1) throw new Error('Employee source refresh completion did not persist')
      return { runId, ...result }
    } catch (error) {
      const saved = await db.execute(sql`update sync_runs set status='failed',finished_at=now(),error_message=${error instanceof Error ? error.message : 'Employee source refresh failed'}
        where org_id=${input.orgId} and id=${runId} returning id`)
      if (saved.rows.length !== 1) throw new Error('Employee source refresh failure did not persist', { cause: error })
      throw error
    }
  })
}
