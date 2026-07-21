import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

/** Clear a project's manual/locked version for future approval. Approved time
 * and posted journals remain immutable; draft and submitted entries are made
 * eligible for fresh resolution on their next approval. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { orgId } = gate.user
  try {
    const count = await db.transaction(async (tx) => {
      const project = (await tx.execute(sql`
        update projects set labor_rate_locked_version_id = null, labor_rate_lock_date = null,
                            updated_at = now(), updated_by = ${gate.user.id}
         where id = ${id} and org_id = ${orgId} returning id`)) as any
      if (!project.rows.length) throw new Error('not found')
      const reset = (await tx.execute(sql`
        update time_entries set direct_cost_rate = null, burden_rate = null, cost_rate = null, bill_rate = null,
                                transfer_rate = null, standard_cost_amount = null, cost_rate_version_id = null,
                                bill_rate_version_id = null, rate_resolved_at = null, rate_resolution_hash = null,
                                updated_at = now(), updated_by = ${gate.user.id}
         where org_id = ${orgId} and project_id = ${id} and status in ('draft','submitted')
        returning id`)) as any
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'projects', ${id}, 'update',
                ${JSON.stringify({ labor_rate_locked_version_id: null, action: 'reset-unapproved-labor-rate-lock' })}, ${gate.user.id})`)
      return reset.rows.length
    })
    return NextResponse.json({ unapprovedEntries: count })
  } catch (error) {
    const message = (error as Error).message
    return NextResponse.json({ error: message }, { status: message === 'not found' ? 404 : 422 })
  }
}
