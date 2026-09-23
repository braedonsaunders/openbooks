import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { getAuthz, can } from '@/lib/authz'
import { guardComplianceFeature } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'
import { canonicalDecimal } from '@/lib/exact-decimal'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'

export const runtime = 'nodejs'

/** Whole-digit width of a canonical decimal: numeric(19,4) holds 15. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

function optionalCoverageMoney(value: unknown): string | null | 'invalid' {
  if (value == null || value === '') return null
  const exact = canonicalDecimal(value, 4)
  // coverage_amount/aggregate_amount are numeric(19,4): refuse whole-digit
  // widths the column cannot hold before any write.
  if (exact === null || wholeDigits(exact) > 15) return 'invalid'
  return normalizeMoney(exact)
}

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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
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
  if (!['verify', 'reject', 'reopen', 'update'].includes(action)) {
    return NextResponse.json({ error: 'unknown certificate action' }, { status: 400 })
  }
  const needed = action === 'update' ? 'compliance.manage' : 'compliance.verify'
  if (!can(authz, needed)) {
    return NextResponse.json({ error: `missing permission: ${needed}` }, { status: 403 })
  }

  const before = (await db.execute<Record<string, unknown>>(sql`
    select id, status, party_id, requirement_id, supersedes_id, created_by, effective_from, expires_on,
           coverage_amount, aggregate_amount, coverage_currency, additional_insured,
           waiver_of_subrogation, primary_noncontributory, issuer_name, policy_number
      from compliance_records where org_id = ${orgId} and id = ${id}
  `))
  const record = before.rows[0]
  if (!record) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (record.status === 'superseded') {
    return NextResponse.json({ error: 'a superseded certificate is history and cannot be changed' }, { status: 422 })
  }

  if (action === 'verify' && record.created_by === actorId) {
    // Whoever produced the record cannot also attest to it. Administrators are
    // no exception: a single-person control is not a control.
    return NextResponse.json(
      { error: 'a certificate must be verified by someone other than the person who recorded it' },
      { status: 422 },
    )
  }

  let rejectionReason = ''
  let coverageAmount: string | null | undefined
  let aggregateAmount: string | null | undefined
  try {
    if (action === 'reject') {
      rejectionReason = (body.reason ?? '').trim()
      if (!rejectionReason) {
        return NextResponse.json({ error: 'a rejection needs a reason' }, { status: 400 })
      }
    }

    coverageAmount = action === 'update' && body.coverageAmount !== undefined
      ? optionalCoverageMoney(body.coverageAmount)
      : undefined
    aggregateAmount = action === 'update' && body.aggregateAmount !== undefined
      ? optionalCoverageMoney(body.aggregateAmount)
      : undefined
    if (coverageAmount === 'invalid') {
      return NextResponse.json({ error: 'coverage amount must be a number with no more than four decimal places' }, { status: 422 })
    }
    if (aggregateAmount === 'invalid') {
      return NextResponse.json({ error: 'aggregate amount must be a number with no more than four decimal places' }, { status: 422 })
    }
    // The update casts these straight to date: shape alone admits impossible
    // days ('2026-09-31') that Postgres then refuses with a raw driver
    // failure, so require real calendar dates before any write.
    if (action === 'update' && body.effectiveFrom !== undefined && body.effectiveFrom !== null && !isIsoCalendarDate(body.effectiveFrom)) {
      return NextResponse.json({ error: 'effective date must be a real calendar date (YYYY-MM-DD)' }, { status: 400 })
    }
    if (action === 'update' && body.expiresOn !== undefined && body.expiresOn !== null && !isIsoCalendarDate(body.expiresOn)) {
      return NextResponse.json({ error: 'expiry date must be a real calendar date (YYYY-MM-DD)' }, { status: 400 })
    }

    // Keep the certificate mutation and its immutable audit evidence in one
    // transaction. If recording the evidence fails, PostgreSQL rolls back the
    // action as well, so callers never observe a committed change without a
    // corresponding legal audit event.
    let supersession: { supersededId: string | null; stale: boolean } = { supersededId: null, stale: false }
    await db.transaction(async (tx) => {
      if (action === 'verify') {
        // Verification retires the predecessor the renewal pointed at: the
        // supersession happens here, not at upload, so the prior certificate
        // stays in force while its replacement is still unattested. The
        // retirement runs BEFORE activation because the renewal guard
        // (0071) only honours a pending same-scope successor. A link gone
        // stale since upload (concurrently superseded) does not block the
        // attestation — it is recorded and the verification stands.
        const link = before.rows[0]!['supersedes_id'] as string | null
        if (link) {
          const retired = (await tx.execute<{ id: string }>(sql`
            update compliance_records
               set status = 'superseded', superseded_by_id = ${id},
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${link}
               and status in ('pending_review', 'active')
            returning id
          `))
          if (retired.rows.length === 0) supersession = { supersededId: null, stale: true }
          else supersession = { supersededId: link, stale: false }
        }
        await tx.execute(sql`
          update compliance_records
             set status = 'active', verified_at = now(), verified_by = ${actorId},
                 rejected_reason = null, updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${id}`)
      } else if (action === 'reject') {
        await tx.execute(sql`
          update compliance_records
             set status = 'rejected', rejected_reason = ${rejectionReason},
                 verified_at = null, verified_by = null,
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${id}`)
      } else if (action === 'reopen') {
        await tx.execute(sql`
          update compliance_records
             set status = 'pending_review', rejected_reason = null,
                 verified_at = null, verified_by = null,
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${id}`)
      } else {
        // Editing the substance of a VERIFIED certificate voids its verification:
        // the attestation was about the old numbers.
        await tx.execute(sql`
          update compliance_records
             set issuer_name = coalesce(${body.issuerName ?? null}, issuer_name),
                 policy_number = coalesce(${body.policyNumber ?? null}, policy_number),
                 effective_from = coalesce(${body.effectiveFrom ?? null}::date, effective_from),
                 expires_on = ${body.expiresOn === undefined ? sql`expires_on` : sql`${body.expiresOn}::date`},
                 coverage_amount = ${coverageAmount === undefined ? sql`coverage_amount` : sql`${coverageAmount}`},
                 aggregate_amount = ${aggregateAmount === undefined ? sql`aggregate_amount` : sql`${aggregateAmount}`},
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
      await tx.execute(sql`
        insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'compliance_records', ${id}, ${action === 'update' ? 'update' : action},
                ${JSON.stringify({ before: record, after: body, supersession })}::jsonb, ${actorId})`)
    })
    return NextResponse.json({ id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'save failed' }, { status: 400 })
  }
}
