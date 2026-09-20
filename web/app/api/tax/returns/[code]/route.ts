import { NextResponse } from 'next/server'
import { computeTaxReturn } from '@openbooks/engine/src/tax-returns/return.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../../lib/authz'
import { parseAdjustments } from './tax-return-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** One filing entity's return, or the translated consolidated view: `subsidiary`
 *  (repeat or comma-separated) scopes to the entity's subsidiaries,
 *  `registration` pins the registration, and `presentationCurrency` (+ optional
 *  `rateType`/`rateDate`) declares the translation policy. Restricted callers
 *  keep the historical org-wide denial unless every requested subsidiary is
 *  inside their allowed set. */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { code } = await params
  const p = new URL(req.url).searchParams
  const from = p.get('from')
  const to = p.get('to')
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required' }, { status: 422 })
  }
  const subsidiaryIds = p.getAll('subsidiary').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
  // An explicitly empty subsidiary list is a caller error, not the org-wide
  // return: fail closed rather than silently widening the scope.
  if (p.has('subsidiary') && subsidiaryIds.length === 0 && !p.get('registration')?.trim()) {
    return NextResponse.json({ error: 'subsidiary filter is empty' }, { status: 422 })
  }
  if (subsidiaryIds.length > 0) {
    for (const id of subsidiaryIds) {
      const denied = guardSubsidiaryScope(gate, id)
      if (denied) return denied
    }
  } else {
    const scopeDenied = guardSubsidiaryScope(gate, null)
    if (scopeDenied) return scopeDenied
  }
  const registration = p.get('registration')?.trim() || undefined
  const presentationCurrency = p.get('presentationCurrency')?.trim() || undefined
  const rateType = p.get('rateType')?.trim() || undefined
  const rateDate = p.get('rateDate')?.trim() || undefined
  const filingEntity = subsidiaryIds.length > 0 || registration ? {
    subsidiaryIds,
    ...(registration ? { registrationId: registration } : {}),
  } : undefined
  try {
    const result = await computeTaxReturn(gate.user.orgId, code, from, to, parseAdjustments(p), {
      ...(filingEntity ? { filingEntity } : {}),
      ...(presentationCurrency || rateType || rateDate ? {
        translation: {
          presentationCurrency: presentationCurrency ?? '',
          ...(rateType ? { rateType } : {}),
          ...(rateDate ? { rateDate } : {}),
        },
      } : {}),
    })
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'compute failed' }, { status: 422 })
  }
}
