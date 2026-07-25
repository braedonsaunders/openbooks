import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * Compliance evidence (certificates of insurance, W-9s, licences, bonds).
 *
 * Creation records evidence as `pending_review`, never as accepted: whoever
 * uploads a certificate is not the person who attests that it satisfies the
 * policy. Verification is a separate call needing `compliance.verify`.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('compliance.manage')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user

  const body = (await req.json()) as {
    partyId?: string
    requirementId?: string
    projectId?: string | null
    issuerName?: string | null
    policyNumber?: string | null
    effectiveFrom?: string
    expiresOn?: string | null
    coverageAmount?: string | null
    aggregateAmount?: string | null
    coverageCurrency?: string | null
    additionalInsured?: boolean
    waiverOfSubrogation?: boolean
    primaryNoncontributory?: boolean
    notes?: string | null
    /** Supersede this earlier certificate (a renewal). */
    supersedesId?: string | null
  }
  if (!isUuid(body.partyId ?? '')) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
  if (!isUuid(body.requirementId ?? '')) {
    return NextResponse.json({ error: 'requirementId is required' }, { status: 400 })
  }
  if (!body.effectiveFrom) return NextResponse.json({ error: 'effectiveFrom is required' }, { status: 400 })

  // The requirement must belong to this org, and to the vendor's class — a
  // certificate against an inapplicable policy would never be evaluated and
  // would quietly read as "on file".
  const applicable = (await db.execute(sql`
    select req.id, req.requires_expiry
      from compliance_requirements req
      join vendor_roles vr on vr.org_id = req.org_id and vr.party_id = ${body.partyId}
     where req.org_id = ${orgId} and req.id = ${body.requirementId} and req.is_active
       and (req.class_id is null or req.class_id = vr.compliance_class_id)
  `)) as unknown as { rows: { id: string; requires_expiry: boolean }[] }
  const requirement = applicable.rows[0]
  if (!requirement) {
    return NextResponse.json(
      { error: 'that requirement does not apply to this vendor — check its compliance class' },
      { status: 422 },
    )
  }
  if (requirement.requires_expiry && !body.expiresOn) {
    return NextResponse.json({ error: 'this requirement needs an expiry date' }, { status: 422 })
  }

  try {
    const id = await db.transaction(async (tx) => {
      const inserted = (await tx.execute(sql`
        insert into compliance_records
          (org_id, party_id, requirement_id, project_id, status, issuer_name, policy_number,
           effective_from, expires_on, coverage_amount, aggregate_amount, coverage_currency,
           additional_insured, waiver_of_subrogation, primary_noncontributory, notes,
           created_by, updated_by)
        values (${orgId}, ${body.partyId}, ${body.requirementId}, ${body.projectId ?? null},
                'pending_review', ${body.issuerName ?? null}, ${body.policyNumber ?? null},
                ${body.effectiveFrom}, ${body.expiresOn ?? null},
                ${body.coverageAmount ?? null}, ${body.aggregateAmount ?? null},
                ${body.coverageCurrency ?? null},
                ${body.additionalInsured === true}, ${body.waiverOfSubrogation === true},
                ${body.primaryNoncontributory === true}, ${body.notes ?? null},
                ${actorId}, ${actorId})
        returning id
      `)) as unknown as { rows: { id: string }[] }
      const newId = inserted.rows[0]!.id
      if (body.supersedesId && isUuid(body.supersedesId)) {
        // Renewal: the prior certificate keeps its dates and verification trail
        // and points forward, so the history of what was on file when survives.
        await tx.execute(sql`
          update compliance_records
             set status = 'superseded', superseded_by_id = ${newId},
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${body.supersedesId}
             and party_id = ${body.partyId} and requirement_id = ${body.requirementId}
        `)
      }
      await tx.execute(sql`
        insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'compliance_records', ${newId}, 'insert',
                ${JSON.stringify({ after: { ...body, status: 'pending_review' } })}::jsonb, ${actorId})
      `)
      return newId
    })
    return NextResponse.json({ id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 })
  }
}
