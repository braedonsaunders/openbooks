import { NextResponse } from 'next/server'
import { z } from 'zod'
import { runRevenueRecognition } from '@openbooks/engine/src/revenue-recognition.ts'
import { syncProjectRevenueContracts } from '@openbooks/engine/src/project-revenue.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { guardPermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isoDate, parseJsonBody, uuidId } from '../../../../lib/api/json'

export const runtime = 'nodejs'

const runRecognitionBody = z.object({
  asOfDate: isoDate().optional(),
  obligationId: z
    .string({ error: 'invalid obligation' })
    .refine((v) => uuidId.safeParse(v).success, 'invalid obligation')
    .optional(),
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
    )
    result.problems.push(...projectSync.problems)
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
