import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/org-feature-lock.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

/** DELETE — remove only scripts without execution evidence. Scripts with run
 * history must be deactivated instead so their audit trail remains intact. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('scripts.manage', 'scripts')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const missing = await db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, user.orgId, 'scripts'))) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // Snapshot the whole row first: a hard delete leaves no other trace of a
    // script that could fire on future documents.
    const existing = (await tx.execute<Record<string, unknown>>(sql`
      select * from user_scripts where id = ${id} and org_id = ${user.orgId} for update
    `))
    if (!existing.rows[0]) return true
    const history = await tx.execute(sql`select id from script_runs where script_id = ${id} and org_id = ${user.orgId} limit 1`)
    if (history.rows.length) return NextResponse.json({
      error: 'This script has run history and cannot be deleted. Deactivate it instead to preserve its audit history.',
      code: 'SCRIPT_HAS_RUN_HISTORY',
    }, { status: 409 })
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
  if (missing instanceof NextResponse) return missing
  if (missing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
