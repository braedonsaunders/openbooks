import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const runtime = 'nodejs'

/** DELETE — permanently remove a script. Drafts and inactive scripts can be
 *  deleted freely; an active script is deactivated first (its script_runs
 *  rows are kept for audit). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('scripts.manage', 'scripts')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute<{ is_active: boolean }>(sql`
    select is_active from user_scripts where id = ${id} and org_id = ${user.orgId}
  `))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await db.execute(sql`delete from user_scripts where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}
