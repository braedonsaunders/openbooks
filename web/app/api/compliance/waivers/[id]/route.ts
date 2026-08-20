import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * Revoke an exception. Revocation is recorded, not deleted: the window during
 * which a blocking requirement was suspended is exactly what a reviewer needs
 * to see, so the row stays and gains a revocation reason and actor.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('compliance.waive')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { reason?: string }
  const reason = (body.reason ?? '').trim()
  if (!reason) return NextResponse.json({ error: 'a revocation needs a reason' }, { status: 400 })

  const updated = (await db.execute<{ id: string }>(sql`
    update compliance_waivers
       set revoked_at = now(), revoked_by = ${actorId}, revoke_reason = ${reason},
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${id} and revoked_at is null
    returning id
  `))
  if (updated.rows.length === 0) {
    return NextResponse.json({ error: 'not found or already revoked' }, { status: 404 })
  }
  await db.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'compliance_waivers', ${id}, 'update',
            ${JSON.stringify({ after: { revoked: true, reason } })}::jsonb, ${actorId})`)
  return NextResponse.json({ id })
}
