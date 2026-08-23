import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { decideGate } from '@openbooks/engine/src/flows/index.ts'
import { isUuid } from '../../../../../lib/list-params'
import { loadGateHeader, requireFlowsSession } from '../../_lib'

export const runtime = 'nodejs'

/**
 * Bulk approve/reject for the approvals worklist. Accepts a list of flow gates:
 *
 *   POST { items: [{ gateId }], decision, comment? }
 *   →    { results: [{ ok, error? }] }   // same order as items
 *
 * Each item is decided independently (per-item try/catch); decideGate is the
 * single authority for who may decide (assignee / admin / delegate, submitter
 * refused). One failure never aborts the rest, and there is deliberately no
 * batch cap (source platform's 50-row bulk-approve limit is a gap this hub closes).
 */

type BulkItem = { gateId?: string }

export async function POST(req: Request) {
  const authz = await requireFlowsSession()
  if (authz instanceof NextResponse) return authz

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
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
      if (!item.gateId) {
        results.push({ ok: false, error: 'invalid item' })
        continue
      }
      if (!isUuid(item.gateId)) throw new Error('invalid gateId')
      const gate = await loadGateHeader(item.gateId, authz.user.orgId)
      if (!gate) throw new Error('approval not found')
      if (gate.status !== 'pending') throw new Error('this approval was already resolved')
      // decideGate is the single authority (assignee / admin / delegate).
      await decideGate({ gateId: item.gateId, decision, userId: authz.user.id, comment })
      results.push({ ok: true })
    } catch (e) {
      results.push({ ok: false, error: e instanceof Error ? e.message : 'failed' })
    }
  }

  return NextResponse.json({ results })
}
