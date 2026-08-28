import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import {
  ensureFiling,
  FORM_TYPES,
  InformationReturnError,
  type FormType,
} from '@openbooks/engine/src/information-returns.ts'
import { guardPermission, guardSubsidiaryScope } from '@/lib/authz'
import { guardComplianceFeature, loadFilings } from '@/lib/compliance'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

export async function GET() {
  const gate = await guardPermission('compliance.read')
  if (gate instanceof NextResponse) return gate
  const blocked = await guardComplianceFeature(gate.user.orgId)
  if (blocked) return blocked
  return NextResponse.json({ filings: await loadFilings(gate.user.orgId, gate.allowedSubsidiaryIds) })
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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    taxYear?: number
    formType?: string
    subsidiaryId?: string | null
    threshold?: string
  }
  const taxYear = Number(body.taxYear)
  if (!Number.isInteger(taxYear) || taxYear < 1990 || taxYear > 2200) {
    return NextResponse.json({ error: 'a four-digit tax year is required' }, { status: 400 })
  }
  if (taxYear > Number((await businessToday(orgId)).slice(0, 4))) {
    return NextResponse.json({ error: 'that tax year has not started yet' }, { status: 422 })
  }
  if (!FORM_TYPES.includes(body.formType as FormType)) {
    return NextResponse.json({ error: `formType must be one of ${FORM_TYPES.join(', ')}` }, { status: 400 })
  }
  let subsidiaryId: string | null = null
  if (Object.prototype.hasOwnProperty.call(body, 'subsidiaryId')) {
    const rawSubsidiaryId = body.subsidiaryId
    if (rawSubsidiaryId !== null && (typeof rawSubsidiaryId !== 'string' || !isUuid(rawSubsidiaryId))) {
      return NextResponse.json({ error: 'subsidiaryId must be a valid UUID' }, { status: 400 })
    }
    subsidiaryId = rawSubsidiaryId ?? null
  }
  const scopeDenied = guardSubsidiaryScope(gate, subsidiaryId)
  if (scopeDenied) return scopeDenied

  if (subsidiaryId !== null) {
    const [subsidiary] = (
      await db.execute<{ id: string }>(sql`
        select id
          from subsidiaries
         where id = ${subsidiaryId}
           and org_id = ${orgId}
           and is_active`)
    ).rows
    if (!subsidiary) return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const [org] = (
    (await db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${orgId}`))
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
