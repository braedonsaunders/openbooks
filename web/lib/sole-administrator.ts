import 'server-only'

import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '@openbooks/engine/platform/database'

/**
 * How many OTHER active users of the organization can administer users.
 *
 * Linking a login to its own person is a separation-of-duties act: another
 * administrator performs it. An organization with exactly one active user
 * administrator has nobody else who could, so the sole administrator may
 * perform an attested, audited self-link; the moment a second active user
 * administrator exists this returns a positive count and the rule applies
 * again. Role grants and grant overrides of admin.users.manage (or a
 * wildcard covering it) confer the authority; a matching deny removes it.
 */
export async function countOtherActiveUserAdministrators(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<number> {
  const row = (await exec.execute<{ n: number }>(sql`
    select count(*)::int as n
      from users u
     where u.org_id = ${orgId}
       and u.is_active
       and u.id <> ${actorId}
       and not exists (
         select 1 from user_permission_overrides o
          where o.org_id = u.org_id and o.user_id = u.id and o.effect = 'deny'
            and o.permission in ('admin.users.manage', 'admin.*', '*'))
       and (
         exists (
           select 1 from role_assignments ra
             join app_roles r on r.id = ra.role_id and r.org_id = ra.org_id
            where ra.org_id = u.org_id and ra.user_id = u.id
              and r.permissions ?| array['admin.users.manage', 'admin.*', '*'])
         or exists (
           select 1 from user_permission_overrides o
            where o.org_id = u.org_id and o.user_id = u.id and o.effect = 'grant'
              and o.permission in ('admin.users.manage', 'admin.*', '*')))
  `)).rows[0]
  if (!row) throw new Error('administrator count returned no row')
  return row.n
}
