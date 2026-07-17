import { NextResponse } from 'next/server'
import { computeTaxReturn } from '@openbooks/engine/src/tax-return.ts'
import { guardPermission } from '../../../../../lib/authz'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT_RE = /^-?\d+(\.\d+)?$/

/** Adjustment-box amounts arrive as `adj_<lineCode>=<amount>` query params. */
export function parseAdjustments(p: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of p) {
    if (!key.startsWith('adj_')) continue
    if (AMOUNT_RE.test(value)) out[key.slice(4)] = value
  }
  return out
}

/** Compute a configured tax return for a period, returning its boxes as JSON. */
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
  try {
    const result = await computeTaxReturn(gate.user.orgId, code, from, to, parseAdjustments(p))
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'compute failed' }, { status: 422 })
  }
}
