import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/** Longest exception anyone can grant in one go. A year-long "temporary"
 *  exception is a policy change, and belongs in the policy. */
const MAX_WAIVER_DAYS = 120

/**
 * Grant an exception to a compliance requirement for one vendor.
 *
 * This is the ONLY legitimate way past a blocking requirement, and it is
 * deliberately expensive to use: its own permission, a mandatory reason, a
 * mandatory end date inside a hard ceiling, and a permanent audit entry.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('compliance.waive')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    partyId?: string
    requirementId?: string
    projectId?: string | null
    reason?: string
    effectiveFrom?: string
    expiresOn?: string
  }
  if (!isUuid(body.partyId ?? '')) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
  if (!isUuid(body.requirementId ?? '')) {
    return NextResponse.json({ error: 'requirementId is required' }, { status: 400 })
  }
  const reason = (body.reason ?? '').trim()
  if (reason.length < 10) {
    return NextResponse.json({ error: 'an exception needs a reason of at least 10 characters' }, { status: 400 })
  }
  const effectiveFrom = body.effectiveFrom ?? (await businessToday(orgId))
  if (!body.expiresOn) return NextResponse.json({ error: 'an exception must have an end date' }, { status: 400 })
  const span = Math.round(
    (Date.parse(`${body.expiresOn}T00:00:00Z`) - Date.parse(`${effectiveFrom}T00:00:00Z`)) / 86_400_000,
  )
  if (!Number.isFinite(span) || span < 0) {
    return NextResponse.json({ error: 'the end date must not precede the start date' }, { status: 400 })
  }
  if (span > MAX_WAIVER_DAYS) {
    return NextResponse.json(
      { error: `an exception cannot run longer than ${MAX_WAIVER_DAYS} days — change the policy instead` },
      { status: 422 },
    )
  }

  try {
    const id = await db.transaction(async (tx) => {
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into compliance_waivers
          (org_id, party_id, requirement_id, project_id, reason, effective_from, expires_on,
           approved_by, created_by, updated_by)
        values (${orgId}, ${body.partyId}, ${body.requirementId}, ${body.projectId ?? null},
                ${reason}, ${effectiveFrom}, ${body.expiresOn}, ${actorId}, ${actorId}, ${actorId})
        returning id
      `))
      const newId = inserted.rows[0]!.id
      await tx.execute(sql`
        insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'compliance_waivers', ${newId}, 'insert',
                ${JSON.stringify({ after: { ...body, reason, effectiveFrom } })}::jsonb, ${actorId})`)
      return newId
    })
    return NextResponse.json({ id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 })
  }
}
