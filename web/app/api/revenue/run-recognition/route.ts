import { NextResponse } from 'next/server'
import { z } from 'zod'
import { runRevenueRecognition } from '@openbooks/engine/src/revenue/recognition.ts'
import { syncProjectRevenueContracts } from '@openbooks/engine/src/projects/revenue.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { revenueRecognitionErrorResponse } from '../../../../lib/revenue-recognition-error'
import { isoDate, parseJsonBody, uuidId } from '../../../../lib/api/json'

export const runtime = 'nodejs'

const scopedId = (label: string) =>
  z
    .string({ error: `invalid ${label}` })
    .refine((v) => uuidId.safeParse(v).success, `invalid ${label}`)
    .optional()

const runRecognitionBody = z.object({
  asOfDate: isoDate().optional(),
  obligationId: scopedId('obligation'),
  // Reviewed-run scope. Present only when the drawer confirms a preview;
  // the legacy immediate call sends none of it and behaves exactly as before.
  contractId: scopedId('contract'),
  bookId: scopedId('book'),
  periodId: scopedId('period'),
  fingerprint: z.string().min(1).optional(),
})

export type RunRecognitionRequest = z.input<typeof runRecognitionBody>

/**
 * Run revenue recognition: post every due, unposted schedule line through the
 * kernel (DR deferred / CR earned, origin='revenue_recognition'), idempotently.
 * Optional `obligationId` scopes the run to one obligation; `asOfDate` defaults
 * to today.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('ar.post')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  if (!(await isFeatureEnabled(user.orgId, 'revenueRecognition'))) {
    return NextResponse.json({ error: 'feature disabled' }, { status: 404 })
  }

  const parsed = await parseJsonBody(req, runRecognitionBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const asOfDate = body.asOfDate ?? (await businessToday(user.orgId))
  // Snapshot the authorization set once and carry that exact policy through
  // both project synchronization and recognition posting. `null` means
  // unrestricted; an empty Set is a restricted caller with no permitted legal
  // entities and must not reach either engine boundary.
  const allowedSubsidiaryIds = gate.allowedSubsidiaryIds === null
    ? undefined
    : [...gate.allowedSubsidiaryIds]

  if (allowedSubsidiaryIds?.length === 0) {
    return NextResponse.json({
      posted: 0,
      skipped: 0,
      totalAmount: '0',
      entries: [],
      problems: [],
    })
  }

  try {
    // Refresh fixed-price project contracts first (percent complete → catch-up
    // schedule lines), so the run below posts current project progress too.
    const projectsEnabled = await isFeatureEnabled(user.orgId, 'projects')
    const projectSync = projectsEnabled
      ? await syncProjectRevenueContracts(
          user.orgId,
          user.id,
          asOfDate,
          undefined,
          allowedSubsidiaryIds,
        )
      : { problems: [] }
    const result = await runRevenueRecognition(
      user.orgId,
      asOfDate,
      user.id,
      body.obligationId,
      allowedSubsidiaryIds,
      // A confirmed run carries the fingerprint of exactly what the operator
      // reviewed; the engine re-derives that set and refuses before writing
      // anything if it moved.
      body.fingerprint
        ? {
            fingerprint: body.fingerprint,
            scope: {
              asOfDate,
              obligationId: body.obligationId,
              contractId: body.contractId,
              bookId: body.bookId,
              periodId: body.periodId,
              allowedSubsidiaryIds,
            },
          }
        : undefined,
    )
    result.problems.push(...projectSync.problems)
    return NextResponse.json(result)
  } catch (e: unknown) {
    return revenueRecognitionErrorResponse(e, 'Unable to run revenue recognition.')
  }
}
