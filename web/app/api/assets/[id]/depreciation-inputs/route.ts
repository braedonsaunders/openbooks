import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { buildAllSchedules, recordDepreciationInput } from '@openbooks/engine/src/assets/depreciation.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { moneyRefusal } from '../../../../../lib/payroll-decimal-refusal'

export const runtime = 'nodejs'

interface Body {
  effectiveDate?: unknown
  kind?: unknown
  value?: unknown
  memo?: unknown
  evidenceFileId?: unknown
  bookId?: unknown
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('assets.manage', 'fixedAssets')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  const effectiveDate = typeof body.effectiveDate === 'string' ? body.effectiveDate : ''
  const kind = body.kind === 'manual' || body.kind === 'production_usage' ? body.kind : null
  const valueRaw = canonicalDecimal(body.value, 4)
  const memo = typeof body.memo === 'string' ? body.memo : ''
  const evidenceFileId = typeof body.evidenceFileId === 'string' ? body.evidenceFileId : ''
  if (body.bookId !== undefined && (typeof body.bookId !== 'string' || !isUuid(body.bookId))) {
    return NextResponse.json({ error: 'book id is invalid' }, { status: 422 })
  }
  const bookId = typeof body.bookId === 'string' ? body.bookId : undefined
  if (!kind || !effectiveDate || !isUuid(evidenceFileId)) {
    return NextResponse.json({ error: 'method, effective date, value, and attached evidence file are required' }, { status: 422 })
  }
  // Shape alone admits impossible dates ('2026-09-31') that Postgres then
  // refuses inside the period lookup with a raw driver failure.
  if (!isIsoCalendarDate(effectiveDate)) {
    return NextResponse.json({ error: 'effective date must be a real calendar date (YYYY-MM-DD)' }, { status: 422 })
  }
  if (valueRaw === null) {
    return NextResponse.json({ error: moneyRefusal('Value', body.value) }, { status: 422 })
  }
  const value = normalizeMoney(valueRaw)

  const visible = (await db.execute(sql`
    select 1 from fixed_assets where id = ${id} and org_id = ${gate.user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
  `))
  if (!visible.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // The scope rides into both locked writes: the visibility precheck above
  // races a concurrent PATCH moving the asset to a restricted subsidiary.
  const scope = gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : undefined
  try {
    await buildAllSchedules(id, gate.user.orgId, gate.user.id, scope)
    const result = await recordDepreciationInput({
      orgId: gate.user.orgId,
      assetId: id,
      bookId,
      effectiveDate,
      kind,
      value,
      memo,
      evidenceFileId,
      actorId: gate.user.id,
      allowedSubsidiaryIds: scope,
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not record depreciation evidence' },
      { status: 422 },
    )
  }
}
