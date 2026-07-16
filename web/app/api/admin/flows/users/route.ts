import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Active org users (id + name) for the builder's assignee / recipient /
 * escalation "specific user" pickers. There is no other GET users listing —
 * /api/admin/users is mutations-only — so the flows builder owns this one.
 */
export async function GET() {
  const gate = await guardPermission('flows.manage')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select id, name, email from users
     where org_id = ${gate.user.orgId} and is_active
     order by name
  `)) as unknown as { rows: { id: string; name: string; email: string }[] }
  return NextResponse.json({
    users: r.rows.map((u) => ({ id: String(u.id), name: String(u.name), email: String(u.email) })),
  })
}
