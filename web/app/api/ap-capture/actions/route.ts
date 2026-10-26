import { z } from 'zod'
import { uuidString } from '@openbooks/engine/platform/identifiers'
import { defineRoute } from '@/lib/api/route'
import { parseJsonBody } from "@/lib/api/json"
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { apCaptureReprocessJobId, enqueueApCapture } from '@openbooks/jobs'
import { db, type SqlExecutor } from '@openbooks/engine/platform/db'
import { lockScopeRows, ScopeNotFoundError } from '@openbooks/engine/organization/scope'
import { CaptureMaterializationError, materializeCapture, type ActivatedCaptureRule } from '@openbooks/engine/payables/ap-capture-service'
import { parseBulkActionIds } from '../../../../lib/api/bulk-ids'
import { apCaptureSubsidiaryScope } from '@openbooks/engine/records/file-cabinet-access'

const captureIds = z.array(uuidString()).min(1).max(50)
const requestBodySchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('reject'), ids: captureIds }),
  z.strictObject({ action: z.literal('materialize'), ids: captureIds, priceOverride: z.boolean().optional() }),
  z.strictObject({ action: z.literal('reprocess'), ids: captureIds, confirmDiscardCorrections: z.boolean().optional() }),
])


export const runtime = 'nodejs'

function apCaptureVisibleExists(orgId: string, id: string, allowed: ReadonlySet<string> | null) {
  return sql`exists (
    select 1 from ap_capture_items ci
    left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
    left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
    where ci.org_id = ${orgId} and ci.id = ${id}
    ${apCaptureSubsidiaryScope(allowed)}
  )`
}

async function lockApCaptureScope(
  tx: SqlExecutor,
  orgId: string,
  id: string,
  allowed: ReadonlySet<string> | null,
): Promise<boolean> {
  const capture = (await tx.execute<{ vendorId: string | null; purchaseOrderId: string | null }>(sql`
    select vendor_candidate_id as "vendorId", purchase_order_id as "purchaseOrderId"
      from ap_capture_items where org_id = ${orgId} and id = ${id} for update
  `, 'objects'))[0]
  if (!capture) return false
  try {
    await lockScopeRows(tx, orgId, [
      ...(capture.vendorId ? [{ kind: 'party' as const, id: capture.vendorId }] : []),
      ...(capture.purchaseOrderId ? [{ kind: 'document' as const, id: capture.purchaseOrderId }] : []),
    ], allowed, 'share', { orgWideNull: true })
    return true
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return false
    throw error
  }
}

export const POST = defineRoute({
  permission: 'ap.create',
  feature: { none: 'No optional feature applies to this permission-governed endpoint.' },
  handler: async ({ request: request, authz: gate }) => {
    const parsedBody = await parseJsonBody(request, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = parseBulkActionIds(parsedBody.data)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.error === 'not_found' ? 404 : 400 })
    }
    const action = parsed.action
    const ids = parsed.ids
    const results: Array<{ id: string; ok: boolean; error?: string; errorCode?: string; details?: Record<string, unknown>; corrections?: number; documentId?: string; rulesActivated?: ActivatedCaptureRule[] }> = []
    for (const id of ids) {
      try {
        if (action === 'reject') {
          await db.transaction(async (tx) => {
            if (!await lockApCaptureScope(tx, gate.user.orgId, id, gate.allowedSubsidiaryIds)) {
              throw new Error('not_rejectable')
            }
            const changed = (await tx.execute<{ id: string }>(sql`
              update ap_capture_items set status = 'rejected', updated_at = now(), updated_by = ${gate.user.id}
               where org_id = ${gate.user.orgId} and id = ${id} and status <> 'materialized'
                 and ${apCaptureVisibleExists(gate.user.orgId, id, gate.allowedSubsidiaryIds)}
               returning id
            `, 'objects'))
            if (!changed[0]) throw new Error('not_rejectable')
            await tx.execute(sql`
              insert into ap_capture_events (org_id, capture_item_id, event_kind, actor_id)
              values (${gate.user.orgId}, ${id}, 'rejected', ${gate.user.id})
            `)
          })
          results.push({ id, ok: true })
        } else if (action === 'reprocess') {
          // Reprocessing re-extracts from the provider and overwrites
          // normalized, so the operator's review corrections recorded in
          // ap_capture_corrections would be silently discarded. A corrected
          // capture requires an explicit confirmDiscardCorrections flag; the
          // confirmed queue records how many corrections it discarded.
          const confirmDiscard = parsedBody.data.action === 'reprocess'
            && parsedBody.data.confirmDiscardCorrections === true
          const queued = await db.transaction(async (tx) => {
            if (!await lockApCaptureScope(tx, gate.user.orgId, id, gate.allowedSubsidiaryIds)) {
              throw new Error('not_reprocessable')
            }
            const corrected = (await tx.execute<{ n: number }>(sql`
              select count(*)::int as n from ap_capture_corrections
               where org_id = ${gate.user.orgId} and capture_item_id = ${id}
            `, 'objects'))[0]!.n
            if (corrected > 0 && !confirmDiscard) {
              const error = new Error(`reprocessing discards ${corrected} operator correction${corrected === 1 ? '' : 's'} — resubmit with confirmDiscardCorrections to discard them and reprocess`) as Error & { errorCode?: string; corrections?: number }
              error.errorCode = 'confirm_required'
              error.corrections = corrected
              throw error
            }
            // The attempt generation is read inside the same transaction that
            // queues the item, so a double-click or retried request derives the
            // same deterministic job id and dedupes in BullMQ; a later
            // generation (after the worker's claim increments attempts) mints a
            // new one. A wall-clock id here would dedupe nothing (E01).
            const changed = (await tx.execute<{ id: string; attempts: number }>(sql`
              update ap_capture_items set status = 'queued', last_error = null, updated_at = now(), updated_by = ${gate.user.id}
               where org_id = ${gate.user.orgId} and id = ${id} and status in ('failed','needs_review','ready','duplicate')
                 and ${apCaptureVisibleExists(gate.user.orgId, id, gate.allowedSubsidiaryIds)}
               returning id, attempts
            `, 'objects'))
            if (!changed[0]) throw new Error('not_reprocessable')
            const generation = changed[0].attempts
            await tx.execute(sql`
              insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
              values (${gate.user.orgId}, ${id}, 'reprocess_queued',
                      ${corrected > 0 ? JSON.stringify({ discardedCorrections: corrected }) : '{}'}::jsonb,
                      ${gate.user.id})
            `)
            return { corrected, generation }
          }).catch((error: unknown) => {
            if (error instanceof Error && (error as Error & { errorCode?: string }).errorCode === 'confirm_required') {
              results.push({
                id,
                ok: false,
                error: error.message,
                errorCode: 'confirm_required',
                corrections: (error as Error & { corrections?: number }).corrections,
              })
              return null
            }
            throw error
          })
          if (queued === null) continue
          try {
            // Freeze the operator's subsidiary scope at enqueue time. The
            // worker re-derives scope from the actor when the job carries
            // none, so an omitted field would let a later scope expansion
            // widen what this reprocess may auto-materialize. The materialize
            // path below already freezes it; reprocess must do the same.
            await enqueueApCapture({ orgId: gate.user.orgId, captureItemId: id, actorId: gate.user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds === null ? null : [...gate.allowedSubsidiaryIds] }, { jobId: apCaptureReprocessJobId(id, queued.generation) })
          } catch (error) {
            const message = error instanceof Error ? error.message.slice(0, 300) : 'queue_unavailable'
            await db.transaction(async (tx) => {
              await tx.execute(sql`
                update ap_capture_items set status = 'failed', last_error = ${message}, updated_at = now()
                 where org_id = ${gate.user.orgId} and id = ${id} and status = 'queued'
                   and ${apCaptureVisibleExists(gate.user.orgId, id, gate.allowedSubsidiaryIds)}
              `)
              await tx.execute(sql`
                insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
                values (${gate.user.orgId}, ${id}, 'queue_failed', ${JSON.stringify({ message })}::jsonb, ${gate.user.id})
              `)
            })
            throw error
          }
          results.push({ id, ok: true })
        } else {
          const visible = (await db.execute<{ id: string }>(sql`
            select ci.id
              from ap_capture_items ci
              left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
              left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
             where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
             ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)}
          `, 'objects'))
          if (!visible[0]) throw new Error('Capture item not found')
          const created = await materializeCapture({
            orgId: gate.user.orgId,
            captureItemId: id,
            actorId: gate.user.id,
            priceOverride: parsedBody.data.action === 'materialize' && parsedBody.data.priceOverride === true,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          })
          results.push({ id, ok: true, documentId: created.documentId, rulesActivated: created.rulesActivated })
        }
      } catch (error) {
        const captureError = error instanceof CaptureMaterializationError ? error : null
        results.push({
          id,
          ok: false,
          error: error instanceof Error ? error.message : 'failed',
          errorCode: captureError?.code,
          details: captureError?.details,
        })
      }
    }
    return NextResponse.json({ results })

  },
})
