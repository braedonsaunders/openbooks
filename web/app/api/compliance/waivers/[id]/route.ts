import { jsonObject, parseJsonBody } from "@/lib/api/json";
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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { reason?: string }
  const reason = (body.reason ?? '').trim()
  if (!reason) return NextResponse.json({ error: 'a revocation needs a reason' }, { status: 400 })

  const revokedId = await db.transaction(async (tx) => {
    const updated = (await tx.execute<{ id: string }>(sql`
      update compliance_waivers
         set revoked_at = now(), revoked_by = ${actorId}, revoke_reason = ${reason},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id} and revoked_at is null
      returning id
    `))
    if (updated.rows.length === 0) return null

    await tx.execute(sql`
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'compliance_waivers', ${id}, 'update',
              ${JSON.stringify({ after: { revoked: true, reason } })}::jsonb, ${actorId})`)
    return updated.rows[0]!.id
  })
  if (revokedId === null) {
    return NextResponse.json({ error: 'not found or already revoked' }, { status: 404 })
  }
  return NextResponse.json({ id: revokedId })
}
