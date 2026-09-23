import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  reconcileLegacyObligationProvenance,
  RevenueRecognitionError,
} from '@openbooks/engine/src/revenue/recognition.ts'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { parseJsonBody } from '@/lib/api/json'
import { isUuid } from '@/lib/list-params'
import { auditSetupChange } from '@/lib/setup/audit'

export const runtime = 'nodejs'

const reconcileBody = z.object({
  reason: z.string().trim().min(5).max(500),
})

/**
 * Reconcile one legacy-provenance obligation (0328): the operator attests
 * that the obligation's existing schedule matches the policy actually in
 * force at its creation, lifting the rebuild refusal for that obligation
 * only. Refuses when there is nothing to reconcile (rule not legacy, no
 * schedule evidence, or already reconciled).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('ar.post', 'revenueRecognition')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid obligation' }, { status: 422 })
  const parsed = await parseJsonBody(req, reconcileBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  try {
    await db.transaction(async (tx) => {
      await reconcileLegacyObligationProvenance(tx, gate.user.orgId, id, gate.user.id, parsed.data.reason)
      await auditSetupChange(
        {
          orgId: gate.user.orgId,
          table: 'performance_obligations',
          rowId: id,
          action: 'update',
          changes: {
            before: { legacy_reconciled_at: null },
            after: { legacy_reconciled_at: 'now', reason: parsed.data.reason },
            reason: parsed.data.reason,
          },
          actorId: gate.user.id,
        },
        tx,
      )
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof RevenueRecognitionError) {
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
