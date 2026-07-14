import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { decide } from '@openbooks/engine/src/approvals.ts'
import { getAuthz, can } from '../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Neutral, kind-aware approval decision endpoint used by the shared
 * /approvals worklist. Resolves the approval request's target kind and gates
 * on the matching permission — so bills, invoices, and expense reports all
 * route through one place with consistent, permission-based auth (no legacy
 * role checks).
 */
const APPROVE_PERMISSION: Record<string, string> = {
  vendor_bill: 'ap.approve',
  expense_report: 'ap.approve',
  customer_invoice: 'ar.approve',
}

export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { requestId, stepNumber, decision, note } = (await req.json()) as {
    requestId?: string
    stepNumber?: number
    decision?: 'approved' | 'rejected'
    note?: string
  }
  if (!requestId || stepNumber == null || !['approved', 'rejected'].includes(decision ?? '')) {
    return NextResponse.json({ error: 'requestId, stepNumber, decision required' }, { status: 400 })
  }

  const r = (await db.execute(sql`
    select target_kind from approval_requests where id = ${requestId} and org_id = ${authz.user.orgId}
  `)) as unknown as { rows: { target_kind: string }[] }
  const kind = r.rows[0]?.target_kind
  if (!kind) return NextResponse.json({ error: 'approval request not found' }, { status: 404 })

  const perm = APPROVE_PERMISSION[kind] ?? 'ap.approve'
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }

  try {
    const res = await decide(requestId, stepNumber, decision!, authz.user.id, note)
    return NextResponse.json({ ok: true, ...res })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 })
  }
}
