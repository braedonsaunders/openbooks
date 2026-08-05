import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  ensureFiling,
  FORM_TYPES,
  InformationReturnError,
  type FormType,
} from '@openbooks/engine/src/information-returns.ts'
import { guardPermission } from '@/lib/authz'
import { guardComplianceFeature, loadFilings } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

export async function GET() {
  const gate = await guardPermission('compliance.read')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  return NextResponse.json({ filings: await loadFilings(gate.user.orgId) })
}

/**
 * Open a year's filing. Idempotent per (year, form, entity) so the button is
 * safe to press twice, and refused for a year that has not ended yet — a 1099
 * reports a completed calendar year, and computing a partial one would produce
 * numbers someone would inevitably file.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('compliance.manage')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  const { orgId, id: actorId } = gate.user

  const body = (await req.json()) as {
    taxYear?: number
    formType?: string
    subsidiaryId?: string | null
    threshold?: string
  }
  const taxYear = Number(body.taxYear)
  if (!Number.isInteger(taxYear) || taxYear < 1990 || taxYear > 2200) {
    return NextResponse.json({ error: 'a four-digit tax year is required' }, { status: 400 })
  }
  if (taxYear > new Date().getUTCFullYear()) {
    return NextResponse.json({ error: 'that tax year has not started yet' }, { status: 422 })
  }
  if (!FORM_TYPES.includes(body.formType as FormType)) {
    return NextResponse.json({ error: `formType must be one of ${FORM_TYPES.join(', ')}` }, { status: 400 })
  }
  const subsidiaryId = body.subsidiaryId && isUuid(body.subsidiaryId) ? body.subsidiaryId : null

  const [org] = (
    (await db.execute(sql`select base_currency from orgs where id = ${orgId}`)) as unknown as {
      rows: { base_currency: string }[]
    }
  ).rows

  try {
    const filing = await ensureFiling({
      orgId,
      taxYear,
      formType: body.formType as FormType,
      subsidiaryId,
      currency: org?.base_currency ?? 'USD',
      threshold: body.threshold,
      actorId,
    })
    return NextResponse.json(filing)
  } catch (e) {
    const status = e instanceof InformationReturnError ? 422 : 500
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status })
  }
}
