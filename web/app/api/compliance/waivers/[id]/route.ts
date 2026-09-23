import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission, guardSubsidiaryScope } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * Approve a pending exception request.
 *
 * The second half of the grant: the requester files, somebody else approves.
 * There is no Flow adapter for compliance exceptions (nothing routes them),
 * so the transition lives here directly — same permission, different person.
 * Only a pending, unrevoked request can be approved; the approval stamps who
 * accepted the risk and when, and only approved exceptions suppress
 * blockers in the evaluator.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('compliance.waive')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string }
  if ((body.action ?? 'approve') !== 'approve') {
    return NextResponse.json({ error: 'unknown exception action' }, { status: 400 })
  }

  const row = (await db.execute<{
    requestedBy: string | null
    createdBy: string | null
    approvedAt: string | null
    revokedAt: string | null
    partySubsidiaryId: string | null
    projectSubsidiaryId: string | null
  }>(sql`
    select w.requested_by as "requestedBy", w.created_by as "createdBy",
           w.approved_at as "approvedAt", w.revoked_at as "revokedAt",
           party.subsidiary_id as "partySubsidiaryId", pj.subsidiary_id as "projectSubsidiaryId"
      from compliance_waivers w
      join parties party on party.id = w.party_id and party.org_id = w.org_id
      left join projects pj on pj.id = w.project_id and pj.org_id = w.org_id
     where w.org_id = ${orgId} and w.id = ${id}
  `)).rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const partyDenied = guardSubsidiaryScope(gate, row.partySubsidiaryId, { orgWideNull: true })
  if (partyDenied) return partyDenied
  // A vendor-wide exception has no project leg to fence; a project-scoped
  // one fences exactly like the loaders that list it.
  const projectDenied = guardSubsidiaryScope(gate, row.projectSubsidiaryId, { orgWideNull: true })
  if (projectDenied) return projectDenied
  if (row.revokedAt !== null) {
    return NextResponse.json({ error: 'a revoked exception request cannot be approved' }, { status: 422 })
  }
  if (row.approvedAt !== null) {
    return NextResponse.json({ error: 'not found or already decided' }, { status: 404 })
  }
  const requester = row.requestedBy ?? row.createdBy
  if (requester !== null && requester === actorId) {
    // Whoever asked for the exception cannot also grant it. Administrators
    // are no exception: a single-person grant is not a control.
    return NextResponse.json(
      { error: 'an exception must be approved by someone other than the person who requested it' },
      { status: 422 },
    )
  }

  const approvedId = await db.transaction(async (tx) => {
    const updated = (await tx.execute<{ id: string }>(sql`
      update compliance_waivers
         set approved_by = ${actorId}, approved_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
         and approved_at is null and revoked_at is null
      returning id
    `))
    if (updated.rows.length === 0) return null
    await tx.execute(sql`
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'compliance_waivers', ${id}, 'approve',
              ${JSON.stringify({ before: { approved: false }, after: { approved: true, approvedBy: actorId } })}::jsonb, ${actorId})`)
    return updated.rows[0]!.id
  })
  if (approvedId === null) {
    return NextResponse.json({ error: 'not found or already decided' }, { status: 404 })
  }
  return NextResponse.json({ id: approvedId, status: 'approved' })
}

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
