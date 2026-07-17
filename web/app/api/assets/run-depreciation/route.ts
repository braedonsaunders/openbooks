import { NextResponse } from 'next/server'
import { runDepreciation } from '@openbooks/engine/src/depreciation.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface Body {
  asOfDate?: string
  assetId?: string
}

/**
 * Run depreciation: post every due, unposted period entry through the kernel
 * (DR expense / CR accumulated, origin='depreciation'), idempotently. Optional
 * `assetId` scopes the run to one asset; `asOfDate` defaults to today.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('assets.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const body = (await req.json().catch(() => ({}))) as Body
  const asOfDate = body.asOfDate && DATE_RE.test(body.asOfDate) ? body.asOfDate : new Date().toISOString().slice(0, 10)
  if (body.assetId !== undefined && !isUuid(body.assetId)) {
    return NextResponse.json({ error: 'invalid asset' }, { status: 422 })
  }

  try {
    const result = await runDepreciation(
      user.orgId,
      asOfDate,
      user.id,
      body.assetId,
      gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
    )
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
