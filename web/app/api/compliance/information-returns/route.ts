import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  ensureFiling,
  FORM_TYPES,
  InformationReturnError,
  type FormType,
} from '@openbooks/engine/src/compliance/information-returns.ts'
import { guardPermission, guardSubsidiaryScope } from '@/lib/authz'
import { guardComplianceFeature, loadFilings } from '@/lib/compliance'
import { canonicalDecimal } from '@/lib/exact-decimal'
import { moneyRefusal } from '@/lib/payroll-decimal-refusal'
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
  if (taxYear >= Number((await businessToday(orgId)).slice(0, 4))) {
    return NextResponse.json({ error: 'only completed tax years can be filed — that tax year has not ended yet' }, { status: 422 })
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

  // Threshold reaches a numeric(19,4) column raw: junk text or a pasted
  // 20-digit figure would otherwise die in Postgres as a raw storage failure
  // (HTTP 500 — only InformationReturnError maps to 422 below).
  if (body.threshold !== undefined) {
    const exact = canonicalDecimal(body.threshold, 4)
    if (exact === null) {
      return NextResponse.json({ error: moneyRefusal('Threshold', body.threshold) }, { status: 400 })
    }
    if (exact.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length > 15) {
      return NextResponse.json({ error: 'Threshold is out of range — at most 15 whole digits fit the ledger' }, { status: 400 })
    }
  }

  try {
    // No currency is passed: ensureFiling resolves the subsidiary-functional
    // denomination (the units the ledger sums and the thresholds judge), and
    // refuses an org-wide filing across unlike currencies with a
    // scope-per-subsidiary remedy. Labelling with the org base here mixed EUR
    // amounts under a USD label with USD thresholds.
    const filing = await ensureFiling({
      orgId,
      taxYear,
      formType: body.formType as FormType,
      subsidiaryId,
      threshold: body.threshold,
      actorId,
    })
    return NextResponse.json(filing)
  } catch (e) {
    const status = e instanceof InformationReturnError ? 422 : 500
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status })
  }
}
