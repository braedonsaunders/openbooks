import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '../platform/db.ts'
import { actorHasPermission } from './actor-permissions.ts'
import { actorAllowedSubsidiaryIds } from './actor-subsidiaries.ts'
import { ScopeNotFoundError } from './subsidiary-scope.ts'

/** Pin the local actor, assigned roles and overrides while a command uses
 * their current authority. Subject absence and scope denial share one refusal. */
export async function lockActorCommandAuthority(tx: SqlExecutor, orgId: string, actorId: string, subsidiaryId: string | null, permission: string) {
  await tx.execute(sql`select id from users where id=${actorId} order by id for share`)
  await tx.execute(sql`select id from role_assignments where org_id=${orgId} and user_id=${actorId} order by id for share`)
  await tx.execute(sql`select id from app_roles where org_id=${orgId} and id in
    (select role_id from role_assignments where org_id=${orgId} and user_id=${actorId}) order by id for share`)
  await tx.execute(sql`select id from user_permission_overrides where org_id=${orgId} and user_id=${actorId} order by id for share`)
  if (!await actorHasPermission(tx, orgId, actorId, permission)) throw new ScopeNotFoundError()
  const allowed = await actorAllowedSubsidiaryIds(tx, orgId, actorId)
  if (subsidiaryId !== null && allowed !== null && !allowed.has(subsidiaryId)) throw new ScopeNotFoundError()
  return allowed
}
