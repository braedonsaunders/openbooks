import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { buildAllSchedules, recordDepreciationInput } from '@openbooks/engine/src/depreciation.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

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
  const body = (await req.json().catch(() => ({}))) as Body
  const effectiveDate = typeof body.effectiveDate === 'string' ? body.effectiveDate : ''
  const kind = body.kind === 'manual' || body.kind === 'production_usage' ? body.kind : null
  const value = typeof body.value === 'string' || typeof body.value === 'number' ? String(body.value) : ''
  const memo = typeof body.memo === 'string' ? body.memo : ''
  const evidenceFileId = typeof body.evidenceFileId === 'string' ? body.evidenceFileId : ''
  if (body.bookId !== undefined && (typeof body.bookId !== 'string' || !isUuid(body.bookId))) {
    return NextResponse.json({ error: 'book id is invalid' }, { status: 422 })
  }
  const bookId = typeof body.bookId === 'string' ? body.bookId : undefined
  if (!kind || !effectiveDate || !value || !isUuid(evidenceFileId)) {
    return NextResponse.json({ error: 'method, effective date, value, and attached evidence file are required' }, { status: 422 })
  }

  const visible = (await db.execute(sql`
    select 1 from fixed_assets where id = ${id} and org_id = ${gate.user.orgId}
      ${gate.allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${[...gate.allowedSubsidiaryIds].join(',')}}`}::uuid[])` : sql``}
  `))
  if (!visible.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    await buildAllSchedules(id, gate.user.orgId, gate.user.id)
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
    })
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not record depreciation evidence' },
      { status: 422 },
    )
  }
}
