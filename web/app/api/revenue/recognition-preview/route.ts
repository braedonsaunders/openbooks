import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  obligationAttribution,
  previewRevenueRecognition,
  revenueContractAttribution,
} from '@openbooks/engine/src/revenue/recognition.ts'
import { subsidiaryScopeAllows } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { revenueRecognitionErrorResponse } from '../../../../lib/revenue-recognition-error'
import { parseJsonBody } from '../../../../lib/api/json'

export const runtime = 'nodejs'

// Typed preview boundary (never a loose json object: the financial-boundary
// ceiling only shrinks). Read-only — this endpoint performs SELECTs only. No
// locks, no project re-measurement, no claims, no postings; every write
// happens in POST /api/revenue/run-recognition after Confirm.
const previewBody = z.object({
  asOfDate: z.string().optional().nullable(),
  obligationId: z.string().optional().nullable(),
  contractId: z.string().optional().nullable(),
  bookId: z.string().optional().nullable(),
  periodId: z.string().optional().nullable(),
})

export type RecognitionPreviewRequest = z.input<typeof previewBody>

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status })
}

/**
 * A scope id must name a row THIS org owns AND inside the caller's
 * subsidiary scope, or the lookup refuses exactly like a missing id rather
 * than confirming the row exists to an out-of-scope caller. Obligations and
 * contracts resolve through the same entity attribution the run uses, so a
 * preview-by-id can never name what the scoped run would refuse. Books and
 * periods carry no subsidiary lineage (and the preview rows themselves are
 * scope-filtered), so they stay org-checked.
 */
async function ownedId(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  raw: string | null | undefined,
  table: 'accounting_books' | 'accounting_periods' | 'performance_obligations' | 'revenue_contracts',
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  const id = raw?.trim().toLowerCase() || null
  if (!id) return { ok: true, id: null }
  if (!isUuid(id)) return { ok: false }
  if (table === 'performance_obligations') {
    const attribution = await obligationAttribution(db, orgId, id)
    if (!attribution || !subsidiaryScopeAllows(allowedSubsidiaryIds, attribution.subsidiaryId)) return { ok: false }
    return { ok: true, id }
  }
  if (table === 'revenue_contracts') {
    const attribution = await revenueContractAttribution(db, orgId, id)
    if (!attribution || !subsidiaryScopeAllows(allowedSubsidiaryIds, attribution.subsidiaryId)) return { ok: false }
    return { ok: true, id }
  }
  const found = await db.execute(sql`
    select 1 from ${sql.identifier(table)} where id = ${id} and org_id = ${orgId}`)
  return found.rows[0] ? { ok: true, id } : { ok: false }
}

/**
 * Read-only preview behind the Run recognition drawer: every due schedule
 * line in the chosen scope, with the balanced DR deferred / CR recognized
 * pair it would post, the refusals that would hold a line back, and the
 * fingerprint Confirm carries so the run can refuse a stale review.
 */
export async function POST(request: Request) {
  const gate = await guardPermission('ar.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  if (!(await isFeatureEnabled(user.orgId, 'revenueRecognition'))) {
    return NextResponse.json({ error: 'feature disabled' }, { status: 404 })
  }

  const parsed = await parseJsonBody(request, previewBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const asOfDate = body.asOfDate?.trim() || (await businessToday(user.orgId))
  if (!isIsoCalendarDate(asOfDate)) return bad('invalid_as_of_date', 'asOfDate')

  const book = await ownedId(user.orgId, gate.allowedSubsidiaryIds, body.bookId, 'accounting_books')
  if (!book.ok) return bad('book_not_found', 'bookId')
  const period = await ownedId(user.orgId, gate.allowedSubsidiaryIds, body.periodId, 'accounting_periods')
  if (!period.ok) return bad('period_not_found', 'periodId')
  const obligation = await ownedId(user.orgId, gate.allowedSubsidiaryIds, body.obligationId, 'performance_obligations')
  if (!obligation.ok) return bad('obligation_not_found', 'obligationId')
  const contract = await ownedId(user.orgId, gate.allowedSubsidiaryIds, body.contractId, 'revenue_contracts')
  if (!contract.ok) return bad('contract_not_found', 'contractId')

  // A restricted caller with no permitted legal entity previews nothing —
  // never the unrestricted set. Mirrors the run route exactly.
  const allowedSubsidiaryIds =
    gate.allowedSubsidiaryIds === null ? undefined : [...gate.allowedSubsidiaryIds]
  if (allowedSubsidiaryIds?.length === 0) {
    return NextResponse.json({
      asOfDate,
      obligationId: obligation.id,
      contractId: contract.id,
      bookId: book.id,
      periodId: period.id,
      rows: [],
      postableCount: 0,
      skippedCount: 0,
      totalAmount: '0',
      totalDebits: '0',
      totalCredits: '0',
      balanced: true,
      projectSyncPending: false,
      warnings: [],
      fingerprint: '',
    })
  }

  try {
    const preview = await previewRevenueRecognition(user.orgId, {
      asOfDate,
      obligationId: obligation.id ?? undefined,
      contractId: contract.id ?? undefined,
      bookId: book.id ?? undefined,
      periodId: period.id ?? undefined,
      allowedSubsidiaryIds,
    })
    return NextResponse.json(preview)
  } catch (e: unknown) {
    return revenueRecognitionErrorResponse(e, 'Unable to preview revenue recognition.')
  }
}
