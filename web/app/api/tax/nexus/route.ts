import { NextResponse } from 'next/server'
import { computeUsNexusStatus } from '@openbooks/engine/src/us-nexus-ledger.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** US economic-nexus status by state for a period: where the business has met or
 *  is approaching a sales-tax registration threshold. */
export async function GET(req: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const p = new URL(req.url).searchParams
  const from = p.get('from')
  const to = p.get('to')
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required' }, { status: 422 })
  }
  try {
    return NextResponse.json(await computeUsNexusStatus(gate.user.orgId, from, to, gate.allowedSubsidiaryIds))
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'nexus evaluation failed' }, { status: 422 })
  }
}
