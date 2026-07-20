import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Users + roles in the org, for the sharing principal picker. Gated by
 * documents.read (a Manager may not be an org admin, so this avoids the
 * admin-only user/role APIs) and returns only id + display name.
 */
export async function GET() {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId

  const [users, roles] = await Promise.all([
    db.execute(sql`
      select id, coalesce(name, email) as name from users
       where org_id = ${orgId} and is_active order by coalesce(name, email)
    `),
    db.execute(sql`
      select id, name from app_roles where org_id = ${orgId} order by name
    `),
  ])
  return NextResponse.json({
    users: (users as any).rows as { id: string; name: string }[],
    roles: (roles as any).rows as { id: string; name: string }[],
  })
}
