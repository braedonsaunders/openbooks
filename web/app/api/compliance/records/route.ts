import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'
import { canonicalDecimal } from '@/lib/exact-decimal'

export const runtime = 'nodejs'

/** Whole-digit width of a canonical decimal: numeric(19,4) holds 15. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

function optionalCoverageMoney(value: unknown): string | null | 'invalid' | 'range' {
  if (value == null || value === '') return null
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return 'invalid'
  if (wholeDigits(exact) > 15) return 'range'
  return normalizeMoney(exact)
}

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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
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
  // Both ends land in date columns and this verb's catch surfaces the driver
  // text, so refuse anything that is not a real calendar day here with a
  // named 400 before any write is attempted.
  if (!isIsoCalendarDate(body.effectiveFrom)) {
    return NextResponse.json({ error: 'effectiveFrom must be a real calendar date (YYYY-MM-DD)' }, { status: 400 })
  }
  if (body.expiresOn != null && body.expiresOn !== '' && !isIsoCalendarDate(body.expiresOn)) {
    return NextResponse.json({ error: 'expiresOn must be a real calendar date (YYYY-MM-DD)' }, { status: 400 })
  }

  // The requirement must belong to this org, and to the vendor's class — a
  // certificate against an inapplicable policy would never be evaluated and
  // would quietly read as "on file".
  const applicable = (await db.execute<{ id: string; requires_expiry: boolean }>(sql`
    select req.id, req.requires_expiry
      from compliance_requirements req
      join vendor_roles vr on vr.org_id = req.org_id and vr.party_id = ${body.partyId}
     where req.org_id = ${orgId} and req.id = ${body.requirementId} and req.is_active
       and (req.class_id is null or req.class_id = vr.compliance_class_id)
  `))
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

  const coverageAmount = optionalCoverageMoney(body.coverageAmount)
  const aggregateAmount = optionalCoverageMoney(body.aggregateAmount)
  if (coverageAmount === 'invalid') {
    return NextResponse.json({ error: 'coverage amount must be a number with no more than four decimal places' }, { status: 422 })
  }
  if (aggregateAmount === 'invalid') {
    return NextResponse.json({ error: 'aggregate amount must be a number with no more than four decimal places' }, { status: 422 })
  }
  // Both columns are numeric(19,4): a wider figure would die in Postgres,
  // surfacing the full INSERT through the catch below. Refuse it named.
  if (coverageAmount === 'range' || aggregateAmount === 'range') {
    return NextResponse.json({ error: 'coverage figures are out of range — at most 15 whole digits fit the ledger' }, { status: 422 })
  }

  // project_id casts straight to uuid in the queries below: refuse a
  // malformed id with a named 400 before any write is attempted.
  if (body.projectId !== undefined && body.projectId !== null && body.projectId !== '' && !isUuid(body.projectId)) {
    return NextResponse.json({ error: 'projectId must be a valid project id' }, { status: 400 })
  }
  // A renewal names the certificate it replaces. Name a certificate that is
  // not this vendor's, not this requirement's, or already history, and the
  // supersession quietly matches nothing while the POST still reports {id} —
  // so validate the link before any write, and refuse it by name.
  const rawSupersedesId = body.supersedesId ?? null
  if (rawSupersedesId !== null && rawSupersedesId !== '') {
    if (!isUuid(rawSupersedesId)) {
      return NextResponse.json({ error: 'supersedesId must be a valid certificate id' }, { status: 400 })
    }
    const prior = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from compliance_records
       where org_id = ${orgId} and id = ${rawSupersedesId}
         and party_id = ${body.partyId} and requirement_id = ${body.requirementId}
         and project_id is not distinct from ${body.projectId ?? null}::uuid
    `)).rows[0]
    if (!prior) {
      return NextResponse.json(
        { error: 'supersedesId does not identify a certificate for this vendor, requirement and project' },
        { status: 422 },
      )
    }
    if (prior.status === 'superseded') {
      return NextResponse.json({ error: 'that certificate was already superseded' }, { status: 422 })
    }
    if (prior.status !== 'pending_review' && prior.status !== 'active') {
      return NextResponse.json(
        { error: `a ${prior.status} certificate cannot be superseded` },
        { status: 422 },
      )
    }
  }

  try {
    const id = await db.transaction(async (tx) => {
      // A renewal files as pending and only POINTS at its predecessor: the
      // prior certificate stays in force until the renewal is verified, so a
      // still-valid certificate is never superseded by an unattested upload.
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into compliance_records
          (org_id, party_id, requirement_id, project_id, status, supersedes_id,
           issuer_name, policy_number,
           effective_from, expires_on, coverage_amount, aggregate_amount, coverage_currency,
           additional_insured, waiver_of_subrogation, primary_noncontributory, notes,
           created_by, updated_by)
        values (${orgId}, ${body.partyId}, ${body.requirementId}, ${body.projectId ?? null},
                'pending_review', ${rawSupersedesId !== null && rawSupersedesId !== '' ? rawSupersedesId : null},
                ${body.issuerName ?? null}, ${body.policyNumber ?? null},
                ${body.effectiveFrom}, ${body.expiresOn ?? null},
                ${coverageAmount}, ${aggregateAmount},
                ${body.coverageCurrency ?? null},
                ${body.additionalInsured === true}, ${body.waiverOfSubrogation === true},
                ${body.primaryNoncontributory === true}, ${body.notes ?? null},
                ${actorId}, ${actorId})
        returning id
      `))
      const newId = inserted.rows[0]!.id
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
