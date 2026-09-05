import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { can, type Authz } from './authz'

/** One visibility rule for library lists, direct loads, pins and embedded cards.
 * Role membership comes from current tenant assignments, never a client/session
 * role label. Editors may inspect drafts; explicit audience restrictions still
 * apply to them. Only organization administrators can bypass an audience. */
export function insightVisibilitySql(authz: Authz, alias?: string): SQL {
  const column = (name: string) =>
    alias
      ? sql`${sql.identifier(alias)}.${sql.identifier(name)}`
      : sql`${sql.identifier(name)}`
  const status = column('status')
  const roles = column('allowed_roles')
  if (
    !can(authz, 'insights.read') &&
    !can(authz, 'insights.create') &&
    !can(authz, 'insights.publish')
  )
    return sql`false`
  const drafts = can(authz, 'insights.create') || can(authz, 'insights.publish')
  const audience =
    authz.user.isSuperAdmin || can(authz, '*')
      ? sql`true`
      : sql`(
    ${roles} is null or ${roles} = '[]'::jsonb or exists (
      select 1 from role_assignments ia
      join app_roles ir on ir.id = ia.role_id and ir.org_id = ia.org_id
      where ia.user_id = ${authz.user.id} and ia.org_id = ${authz.user.orgId}
        and ${roles} ? ir.key
    )
  )`
  return sql`(${column('org_id')} = ${authz.user.orgId} and (${status} = 'published' or ${drafts}) and ${audience})`
}
