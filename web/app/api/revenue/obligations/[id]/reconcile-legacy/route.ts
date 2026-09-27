import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  reconcileLegacyObligationProvenance,
  RevenueRecognitionError,
} from '@openbooks/engine/src/revenue/recognition.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { defineRoute } from '@/lib/api/route'
import { parseJsonBody } from '@/lib/api/json'
import { isUuid } from '@/lib/list-params'
import { auditSetupChange } from '@/lib/setup/audit'
import { notFound } from "@/lib/api/responses";


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
export const POST = defineRoute({
  permission: 'ar.post',
  feature: 'revenueRecognition',
  params: z.object({ id: z.string() }),
  handler: async ({ request: req, authz: gate, params }) => {
  const { id } = params
  if (!isUuid(id)) return NextResponse.json({ error: 'invalid obligation' }, { status: 422 })
  const parsed = await parseJsonBody(req, reconcileBody, { status: 422 })
  if (!parsed.ok) return parsed.response
  try {
    await db.transaction(async (tx) => {
      // The attestation writes another entity's policy state, so the
      // obligation's entity must be inside the caller's scope: the engine
      // refuses out-of-scope exactly like missing, under the obligation lock.
      await reconcileLegacyObligationProvenance(
        tx, gate.user.orgId, id, gate.user.id, parsed.data.reason, gate.allowedSubsidiaryIds,
      )
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
    if (e instanceof ScopeNotFoundError) {
      return notFound("record")
    }
    if (e instanceof RevenueRecognitionError) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
    console.error('[revenue/reconcile-legacy] reconciliation failed', e)
    return NextResponse.json({ error: 'reconciliation failed' }, { status: 500 })
  }
  },
})
