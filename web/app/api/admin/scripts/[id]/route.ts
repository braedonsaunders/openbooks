import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

/** DELETE — permanently remove a script. Drafts and inactive scripts can be
 *  deleted freely; an active script is deactivated first (its script_runs
 *  rows are kept for audit). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('scripts.manage', 'scripts')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const missing = await db.transaction(async (tx) => {
    // Snapshot the whole row first: a hard delete leaves no other trace of a
    // script that could fire on future documents.
    const existing = (await tx.execute<Record<string, unknown>>(sql`
      select * from user_scripts where id = ${id} and org_id = ${user.orgId}
    `))
    if (!existing.rows[0]) return true
    await tx.execute(sql`delete from user_scripts where id = ${id} and org_id = ${user.orgId}`)
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${user.orgId}, 'user_scripts', ${id}, 'delete',
         ${JSON.stringify({ before: existing.rows[0] })}::jsonb, ${user.id}, ${req.headers.get('X-Request-Id')})
    `)
    return false
  })
  if (missing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
