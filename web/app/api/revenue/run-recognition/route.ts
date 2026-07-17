import { NextResponse } from 'next/server'
import { runRevenueRecognition } from '@openbooks/engine/src/revenue-recognition.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface Body {
  asOfDate?: string
  obligationId?: string
}

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

  const body = (await req.json().catch(() => ({}))) as Body
  const asOfDate = body.asOfDate && DATE_RE.test(body.asOfDate) ? body.asOfDate : new Date().toISOString().slice(0, 10)
  if (body.obligationId !== undefined && !isUuid(body.obligationId)) {
    return NextResponse.json({ error: 'invalid obligation' }, { status: 422 })
  }

  try {
    const result = await runRevenueRecognition(
      user.orgId,
      asOfDate,
      user.id,
      body.obligationId,
      gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
    )
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
