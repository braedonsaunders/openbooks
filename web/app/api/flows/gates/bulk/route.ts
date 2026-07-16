import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { decideGate } from '@openbooks/engine/src/flows/index.ts'
import { decide as decideLegacy } from '@openbooks/engine/src/approvals.ts'
import { getAuthz, can } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadGateHeader } from '../../_lib'

export const runtime = 'nodejs'

/**
 * Bulk approve/reject for the unified approvals worklist. Accepts a mixed
 * list of flow gates and legacy policy steps:
 *
 *   POST { items: [{ gateId } | { requestId, stepNumber }], decision, comment? }
 *   →    { results: [{ ok, error? }] }   // same order as items
 *
 * Each item is decided independently (per-item try/catch) with the SAME
 * authorization the single-item endpoints apply — flow gates go through the
 * decide-route screen + decideGate (the engine is the source of truth),
 * legacy steps through the kind→permission map of /api/approvals/decide. One
 * failure never aborts the rest, and there is deliberately no batch cap
 * (NetSuite's 50-row bulk-approve limit is a gap this hub closes).
 */

type BulkItem = { gateId?: string; requestId?: string; stepNumber?: number }

// Mirror of /api/approvals/decide — keep the two in sync.
const APPROVE_PERMISSION: Record<string, string> = {
  vendor_bill: 'ap.approve',
  expense_report: 'ap.approve',
  customer_invoice: 'ar.approve',
}

export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    items?: BulkItem[]
    decision?: 'approved' | 'rejected'
    comment?: string
  }
  if (
    !Array.isArray(body.items) ||
    body.items.length === 0 ||
    !['approved', 'rejected'].includes(body.decision ?? '')
  ) {
    return NextResponse.json({ error: 'items and decision required' }, { status: 400 })
  }
  const decision = body.decision as 'approved' | 'rejected'
  const comment = body.comment?.trim() || undefined

  const results: { ok: boolean; error?: string }[] = []
  for (const item of body.items) {
    try {
      if (item.gateId) {
        if (!isUuid(item.gateId)) throw new Error('invalid gateId')
        const gate = await loadGateHeader(item.gateId, authz.user.orgId)
        if (!gate) throw new Error('approval not found')
        if (gate.status !== 'pending') throw new Error('this approval was already resolved')
        const screened =
          can(authz, 'flows.approve') ||
          gate.assignee_user_id === authz.user.id ||
          gate.assignee_role !== null // role membership is verified by decideGate
        if (!screened) throw new Error('you are not an approver for this gate')
        await decideGate({ gateId: item.gateId, decision, userId: authz.user.id, comment })
        results.push({ ok: true })
      } else if (item.requestId && item.stepNumber != null) {
        if (!isUuid(item.requestId)) throw new Error('invalid requestId')
        const r = (await db.execute(sql`
          select target_kind from approval_requests
           where id = ${item.requestId} and org_id = ${authz.user.orgId}
        `)) as unknown as { rows: { target_kind: string }[] }
        const kind = r.rows[0]?.target_kind
        if (!kind) throw new Error('approval request not found')
        const perm = APPROVE_PERMISSION[kind] ?? 'ap.approve'
        if (!can(authz, perm)) throw new Error(`missing permission: ${perm}`)
        await decideLegacy(item.requestId, Number(item.stepNumber), decision, authz.user.id, comment)
        results.push({ ok: true })
      } else {
        results.push({ ok: false, error: 'invalid item' })
      }
    } catch (e) {
      results.push({ ok: false, error: e instanceof Error ? e.message : 'failed' })
    }
  }

  return NextResponse.json({ results })
}
