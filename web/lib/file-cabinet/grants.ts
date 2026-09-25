/** Split from web/lib/file-cabinet.ts (ARCH-FILE-SPLIT; pure moves only). */
import 'server-only'
import { type FileViewer, type AccessLevel } from './types'
import { attachmentTargetsVisiblePredicate, recordScopeFolderPredicate } from './visibility'
import { type FileMutationAudit, viewerFileGate, viewerFolderGate, lockCabinetAuthorization, runMutation } from './mutation'
import { sql, type SQL } from 'drizzle-orm'
import { db, inDbTransaction, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { actorAllowedSubsidiaryIds, restrictionSubsidiaryScope, type SubsidiaryTreeNode } from '@openbooks/engine/src/organization/actor-subsidiaries.ts'
import type { SubsidiaryRestriction } from '@openbooks/schema'
import { recordFileEvent } from '../file-audit'

// --- sharing / grants -------------------------------------------------------

export type ResourceType = 'folder' | 'file'
export type PrincipalType = 'user' | 'role'

export type GrantRow = {
  id: string
  principalType: PrincipalType
  principalId: string
  principalName: string
  access: AccessLevel
};

const ACCESS_VALUES: AccessLevel[] = ['viewer', 'editor', 'manager']
export function isAccessLevel(v: unknown): v is AccessLevel {
  return typeof v === 'string' && (ACCESS_VALUES as string[]).includes(v)
}

export class GrantScopeRefusal extends Error {
  constructor() {
    super('the recipient cannot access this resource because it is outside their subsidiary scope; grant a resource within their authorized subsidiaries')
    this.name = 'GrantScopeRefusal'
  }
}

async function recipientSubsidiaryScope(
  tx: SqlExecutor,
  orgId: string,
  principalType: PrincipalType,
  principalId: string,
): Promise<Set<string> | null> {
  if (principalType === 'user') {
    await tx.execute(sql`
      select r.id from role_assignments a
      join app_roles r on r.id = a.role_id and r.org_id = a.org_id
       where a.org_id = ${orgId} and a.user_id = ${principalId}
       order by r.id for share of a, r
    `)
    await tx.execute(sql`select id from subsidiaries where org_id = ${orgId} order by id for share`)
    return actorAllowedSubsidiaryIds(tx, orgId, principalId)
  }
  const role = (await tx.execute<{ restriction: SubsidiaryRestriction | null }>(sql`
    select subsidiary_restriction as restriction from app_roles
     where id = ${principalId} and org_id = ${orgId} for share
  `)).rows[0]
  if (!role) throw new GrantScopeRefusal()
  const subsidiaries = await tx.execute<SubsidiaryTreeNode>(sql`
    select id, parent_id as "parentId" from subsidiaries where org_id = ${orgId} order by id for share
  `)
  const scope = restrictionSubsidiaryScope(role.restriction, subsidiaries.rows)
  if (scope === undefined) throw new GrantScopeRefusal()
  return scope
}

async function grantTargetsWithinScope(
  tx: SqlExecutor,
  orgId: string,
  resourceType: ResourceType,
  resourceId: string,
  allowedSubsidiaryIds: Set<string>,
): Promise<boolean> {
  const viewer: FileViewer = { userId: '', isAdmin: false, baseline: 'none', allowedSubsidiaryIds }
  const scopeOk = (folderId: SQL) => recordScopeFolderPredicate(orgId, viewer, folderId)
  const attachmentsOk = (fileId: SQL) => attachmentTargetsVisiblePredicate(orgId, allowedSubsidiaryIds, fileId) ?? sql`true`
  if (resourceType === 'file') {
    await tx.execute(sql`select id from files where id = ${resourceId} and org_id = ${orgId} for update`)
    const result = await tx.execute(sql`
      select fi.id from files fi
      left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
       where fi.id = ${resourceId} and fi.org_id = ${orgId}
         and ${scopeOk(sql`fo.id`)} and ${attachmentsOk(sql`fi.id`)}
    `)
    return result.rows.length > 0
  }
  await tx.execute(sql`
    with recursive descendants as (
      select id from folders where id = ${resourceId} and org_id = ${orgId}
      union all
      select f.id from folders f join descendants d on f.parent_folder_id = d.id and f.org_id = ${orgId}
    )
    select id from folders where org_id = ${orgId} and id in (select id from descendants) order by id for update
  `)
  const result = await tx.execute(sql`
    with recursive descendants as (
      select id from folders where id = ${resourceId} and org_id = ${orgId}
      union all
      select f.id from folders f join descendants d on f.parent_folder_id = d.id and f.org_id = ${orgId}
    )
    select 1 where exists (select 1 from folders where id = ${resourceId} and org_id = ${orgId})
      and not exists (
      select 1 from folders f
       where f.id in (select id from descendants) and f.org_id = ${orgId}
         and not ${scopeOk(sql`f.id`)}
      union all
      select 1 from files fi
      left join folders fo on fo.id = fi.folder_id and fo.org_id = fi.org_id
       where fi.org_id = ${orgId} and fi.folder_id in (select id from descendants)
         and (not ${scopeOk(sql`fo.id`)} or not ${attachmentsOk(sql`fi.id`)})
    )
  `)
  return result.rows.length > 0
}

/**
 * The grant anchor exists inside this org. Grant routes check this BEFORE the
 * manager gate: the gate alone cannot tell "absent" from "forbidden", so
 * without this check a share against a random UUID persists a dangling
 * resource_grants row plus a share audit event for a resource no read can
 * ever observe.
 */
export async function cabinetResourceExists(
  orgId: string,
  resourceType: ResourceType,
  resourceId: string,
  executor?: SqlExecutor,
): Promise<boolean> {
  const exec = executor ?? db
  const r =
    resourceType === 'folder'
      ? await exec.execute(sql`select 1 from folders where id = ${resourceId} and org_id = ${orgId} limit 1`)
      : await exec.execute(sql`select 1 from files where id = ${resourceId} and org_id = ${orgId} limit 1`)
  return r.rows.length > 0
}

/** The grants on a resource, with resolved principal display names. */
export async function listGrants(
  orgId: string,
  resourceType: ResourceType,
  resourceId: string,
): Promise<GrantRow[]> {
  const r = (await db.execute<GrantRow>(sql`
    select g.id, g.principal_type as "principalType", g.principal_id as "principalId", g.access,
           coalesce(u.name, u.email, ar.name, 'Unknown') as "principalName"
      from resource_grants g
      left join users u on g.principal_type = 'user' and u.id = g.principal_id and u.org_id = ${orgId}
      left join app_roles ar on g.principal_type = 'role' and ar.id = g.principal_id and ar.org_id = ${orgId}
     where g.org_id = ${orgId} and g.resource_type = ${resourceType} and g.resource_id = ${resourceId}
     order by g.principal_type, "principalName"
  `))
  return r.rows
}

/** Create or update a grant (idempotent on principal). */
export async function setGrant(input: {
  orgId: string
  resourceType: ResourceType
  resourceId: string
  principalType: PrincipalType
  principalId: string
  access: AccessLevel
  actorId: string
  audit?: FileMutationAudit
}): Promise<void> {
  await inDbTransaction(async (tx) => {
    await lockCabinetAuthorization(tx, input.orgId)
    const gate =
      input.resourceType === 'folder'
        ? await viewerFolderGate(tx, input.orgId, input.audit, input.resourceId, 'manager')
        : await viewerFileGate(tx, input.orgId, input.audit, input.resourceId, 'manager')
    if (!gate) throw new Error('setGrant refused: caller lacks manager access to the resource')
    const recipientScope = await recipientSubsidiaryScope(tx, input.orgId, input.principalType, input.principalId)
    if (recipientScope !== null && !(await grantTargetsWithinScope(tx, input.orgId, input.resourceType, input.resourceId, recipientScope))) {
      throw new GrantScopeRefusal()
    }
    const previous = (await tx.execute<{ id: string; access: AccessLevel }>(sql`
      select id, access
        from resource_grants
       where org_id = ${input.orgId}
         and resource_type = ${input.resourceType}
         and resource_id = ${input.resourceId}
         and principal_type = ${input.principalType}
         and principal_id = ${input.principalId}
       for update
    `)).rows[0]
    const result = (await tx.execute<{ id: string }>(sql`
      insert into resource_grants
        (org_id, resource_type, resource_id, principal_type, principal_id, access, created_by, updated_by, created_at, updated_at)
      values (${input.orgId}, ${input.resourceType}, ${input.resourceId}, ${input.principalType},
              ${input.principalId}, ${input.access}, ${input.actorId}, ${input.actorId}, now(), now())
      on conflict (org_id, resource_type, resource_id, principal_type, principal_id)
      do update set access = ${input.access}, updated_by = ${input.actorId}, updated_at = now()
      where resource_grants.org_id = ${input.orgId}
      returning id
    `)).rows[0]
    if (!result) throw new Error('grant upsert did not return a row')
    if (input.audit) {
      await recordFileEvent({
        orgId: input.orgId,
        actorId: input.audit.actorId,
        table: input.resourceType === 'folder' ? 'folders' : 'files',
        rowId: input.resourceId,
        action: 'share',
        changes: {
          principalType: input.principalType,
          principalId: input.principalId,
          access: input.access,
          previousAccess: previous?.access ?? null,
        },
        executor: tx,
      })
    }
  })
}

/** Remove a grant by id, bound to the resource the caller authorized. */
export async function removeGrant(
  orgId: string,
  grantId: string,
  resourceType: ResourceType,
  resourceId: string,
  audit?: FileMutationAudit,
): Promise<boolean> {
  return runMutation(audit?.executor, async (tx) => {
    const existing = (await tx.execute<{ id: string; resourceType: ResourceType; resourceId: string }>(sql`
      select id, resource_type as "resourceType", resource_id as "resourceId"
        from resource_grants
       where id = ${grantId} and org_id = ${orgId}
       for update
    `)).rows[0]
    if (!existing || existing.resourceType !== resourceType || existing.resourceId !== resourceId) return false
    const gate =
      resourceType === 'folder'
        ? await viewerFolderGate(tx, orgId, audit, resourceId, 'manager')
        : await viewerFileGate(tx, orgId, audit, resourceId, 'manager')
    if (!gate) return false
    const deleted = (await tx.execute<{ id: string }>(sql`
      delete from resource_grants
       where id = ${grantId} and org_id = ${orgId}
         and resource_type = ${resourceType} and resource_id = ${resourceId}
      returning id
    `)).rows.length > 0
    if (!deleted) return false
    if (audit) {
      await recordFileEvent({
        orgId,
        actorId: audit.actorId,
        table: resourceType === 'folder' ? 'folders' : 'files',
        rowId: resourceId,
        action: 'unshare',
        changes: { grantId },
        executor: tx,
      })
    }
    return true
  }, orgId)
}
