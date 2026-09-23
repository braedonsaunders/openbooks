import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardPermission, guardSubsidiaryScope } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/** Longest exception anyone can grant in one go. A year-long "temporary"
 *  exception is a policy change, and belongs in the policy. */
const MAX_WAIVER_DAYS = 120

/**
 * Request an exception to a compliance requirement for one vendor.
 *
 * Requesting is the first half of the ONLY legitimate way past a blocking
 * requirement: the request files as pending and covers nothing. It becomes
 * effective only when a different person approves it (PATCH waivers/[id]).
 * Both halves are deliberately expensive: their own permission, a mandatory
 * reason, a mandatory end date inside a hard ceiling, segregation of duties,
 * and a permanent audit entry for each transition.
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
  // Date.parse normalises non-calendar dates (2026-09-31 becomes October
  // 1st), so the span math below would bless them and the write would die in
  // the date column, leaking the full INSERT through the catch below. Refuse
  // anything that is not a real calendar date before any write is attempted.
  for (const [label, value] of [['start date', effectiveFrom], ['end date', body.expiresOn]] as const) {
    if (!isIsoCalendarDate(value)) {
      return NextResponse.json({ error: `the ${label} must be a real calendar date (YYYY-MM-DD)` }, { status: 400 })
    }
  }
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

  // Subsidiary fence: no exception for a vendor — or under a project —
  // the caller cannot see. Missing and hidden both read as 404, so the
  // refusal never oracles which ids exist elsewhere.
  const waiverParty = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties where org_id = ${orgId} and id = ${body.partyId}
  `)).rows[0]
  if (!waiverParty) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const waiverPartyDenied = guardSubsidiaryScope(gate, waiverParty.subsidiaryId, { orgWideNull: true })
  if (waiverPartyDenied) return waiverPartyDenied
  if (body.projectId !== undefined && body.projectId !== null) {
    const waiverProject = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select subsidiary_id as "subsidiaryId" from projects where org_id = ${orgId} and id = ${body.projectId}
    `)).rows[0]
    if (!waiverProject) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const waiverProjectDenied = guardSubsidiaryScope(gate, waiverProject.subsidiaryId, { orgWideNull: true })
    if (waiverProjectDenied) return waiverProjectDenied
  }

  try {
    const id = await db.transaction(async (tx) => {
      // Requesting is not granting: the exception files as pending and
      // covers nothing until a different holder of compliance.waive
      // approves it (PATCH waivers/[id]). Whoever requests can never be
      // the one who approves — approval is a separate transition, and the
      // evaluator only honours approved exceptions.
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into compliance_waivers
          (org_id, party_id, requirement_id, project_id, reason, effective_from, expires_on,
           requested_by, approved_by, approved_at, created_by, updated_by)
        values (${orgId}, ${body.partyId}, ${body.requirementId}, ${body.projectId ?? null},
                ${reason}, ${effectiveFrom}, ${body.expiresOn},
                ${actorId}, null, null, ${actorId}, ${actorId})
        returning id
      `))
      const newId = inserted.rows[0]!.id
      await tx.execute(sql`
        insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'compliance_waivers', ${newId}, 'insert',
                ${JSON.stringify({ after: { ...body, reason, effectiveFrom, status: 'pending_approval', requestedBy: actorId } })}::jsonb, ${actorId})`)
      return newId
    })
    return NextResponse.json({ id, status: 'pending_approval' })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 })
  }
}
