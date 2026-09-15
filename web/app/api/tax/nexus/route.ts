import { NextResponse } from 'next/server'
import { computeUsNexusStatus } from '@openbooks/engine/src/us-nexus-ledger.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** US economic-nexus status by state for a period: where the business has met or
 *  is approaching a sales-tax registration threshold. `subsidiary` (repeat or
 *  comma-separated) scopes to one filing entity's ledger in its working
 *  currency; `currency` (+ `rateType`/`rateDate`) declares the working currency
 *  and threshold-translation policy for a mixed entity. */
export async function GET(req: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const p = new URL(req.url).searchParams
  const from = p.get('from')
  const to = p.get('to')
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required' }, { status: 422 })
  }
  const subsidiaryIds = p.getAll('subsidiary').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
  if (p.has('subsidiary') && subsidiaryIds.length === 0) {
    return NextResponse.json({ error: 'subsidiary filter is empty' }, { status: 422 })
  }
  for (const id of subsidiaryIds) {
    const denied = guardSubsidiaryScope(gate, id)
    if (denied) return denied
  }
  const currency = p.get('currency')?.trim() || undefined
  const rateType = p.get('rateType')?.trim() || undefined
  const rateDate = p.get('rateDate')?.trim() || undefined
  try {
    return NextResponse.json(await computeUsNexusStatus(gate.user.orgId, from, to, gate.allowedSubsidiaryIds, {
      ...(subsidiaryIds.length > 0 ? { subsidiaryIds } : {}),
      ...(currency ? { currency } : {}),
      ...(rateType ? { rateType } : {}),
      ...(rateDate ? { rateDate } : {}),
    }))
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'nexus evaluation failed' }, { status: 422 })
  }
}
