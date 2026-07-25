import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { getAuthz, can } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

type Action = 'verify' | 'reject' | 'reopen' | 'update'

/**
 * Act on one certificate.
 *
 * `verify` and `reject` are the attestation duty (`compliance.verify`) and are
 * kept apart from editing the certificate's data (`compliance.manage`) —
 * separation of duties, enforced here rather than assumed from the UI.
 *
 * Nothing is ever deleted. A certificate that should not have been accepted is
 * rejected with a reason, which is what an auditor needs to see.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const blocked = await guardComplianceFeature(authz.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = authz.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json()) as {
    action?: Action
    reason?: string | null
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
  }
  const action: Action = body.action ?? 'update'
  const needed = action === 'update' ? 'compliance.manage' : 'compliance.verify'
  if (!can(authz, needed)) {
    return NextResponse.json({ error: `missing permission: ${needed}` }, { status: 403 })
  }

  const before = (await db.execute(sql`
    select id, status, party_id, requirement_id, created_by, effective_from, expires_on,
           coverage_amount, aggregate_amount, coverage_currency, additional_insured,
           waiver_of_subrogation, primary_noncontributory, issuer_name, policy_number
      from compliance_records where org_id = ${orgId} and id = ${id}
  `)) as unknown as { rows: Record<string, unknown>[] }
  const record = before.rows[0]
  if (!record) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (record.status === 'superseded') {
    return NextResponse.json({ error: 'a superseded certificate is history and cannot be changed' }, { status: 422 })
  }

  try {
    if (action === 'verify') {
      // Whoever produced the record cannot also attest to it. Administrators are
      // no exception: a single-person control is not a control.
      if (record.created_by === actorId) {
        return NextResponse.json(
          { error: 'a certificate must be verified by someone other than the person who recorded it' },
          { status: 422 },
        )
      }
      await db.execute(sql`
        update compliance_records
           set status = 'active', verified_at = now(), verified_by = ${actorId},
               rejected_reason = null, updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    } else if (action === 'reject') {
      const reason = (body.reason ?? '').trim()
      if (!reason) return NextResponse.json({ error: 'a rejection needs a reason' }, { status: 400 })
      await db.execute(sql`
        update compliance_records
           set status = 'rejected', rejected_reason = ${reason},
               verified_at = null, verified_by = null,
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    } else if (action === 'reopen') {
      await db.execute(sql`
        update compliance_records
           set status = 'pending_review', rejected_reason = null,
               verified_at = null, verified_by = null,
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    } else {
      // Editing the substance of a VERIFIED certificate voids its verification:
      // the attestation was about the old numbers.
      await db.execute(sql`
        update compliance_records
           set issuer_name = coalesce(${body.issuerName ?? null}, issuer_name),
               policy_number = coalesce(${body.policyNumber ?? null}, policy_number),
               effective_from = coalesce(${body.effectiveFrom ?? null}::date, effective_from),
               expires_on = ${body.expiresOn === undefined ? sql`expires_on` : sql`${body.expiresOn}::date`},
               coverage_amount = ${body.coverageAmount === undefined ? sql`coverage_amount` : sql`${body.coverageAmount}::numeric`},
               aggregate_amount = ${body.aggregateAmount === undefined ? sql`aggregate_amount` : sql`${body.aggregateAmount}::numeric`},
               coverage_currency = coalesce(${body.coverageCurrency ?? null}, coverage_currency),
               additional_insured = coalesce(${body.additionalInsured ?? null}, additional_insured),
               waiver_of_subrogation = coalesce(${body.waiverOfSubrogation ?? null}, waiver_of_subrogation),
               primary_noncontributory = coalesce(${body.primaryNoncontributory ?? null}, primary_noncontributory),
               notes = coalesce(${body.notes ?? null}, notes),
               status = case when status = 'active' then 'pending_review' else status end,
               verified_at = null, verified_by = null,
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}`)
    }
    await db.execute(sql`
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'compliance_records', ${id}, ${action === 'update' ? 'update' : action},
              ${JSON.stringify({ before: record, after: body })}::jsonb, ${actorId})`)
    return NextResponse.json({ id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 })
  }
}
