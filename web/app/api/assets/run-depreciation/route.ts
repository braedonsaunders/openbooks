import { z } from 'zod'
import { isoDate, parseJsonBody, uuidId } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { runDepreciation } from '@openbooks/engine/src/depreciation.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

export const runtime = 'nodejs'

const runBody = z.object({ asOfDate: isoDate().optional(), assetId: uuidId.optional(), bookId: uuidId.optional() })

/**
 * Run depreciation: post every due, unposted period entry through the kernel
 * (DR expense / CR accumulated, origin='depreciation'), idempotently. Optional
 * `assetId` scopes the run to one asset; `asOfDate` defaults to today.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const parsedBody = await parseJsonBody(req, runBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  const asOfDate = body.asOfDate ?? await businessToday(user.orgId)

  try {
    const result = await runDepreciation(
      user.orgId,
      asOfDate,
      user.id,
      body.assetId,
      gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined,
      body.bookId,
    )
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
