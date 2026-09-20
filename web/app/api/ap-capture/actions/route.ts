import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { enqueueApCapture } from '@openbooks/jobs'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { materializeCapture } from '@openbooks/engine/src/payables/ap-capture-service.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'

export const runtime = 'nodejs'

/**
 * Same vendor/PO visibility the inbox list and `?capture=` flyout apply
 * (`web/app/(app)/ap/capture/view.ts`). Bulk reject/reprocess/materialize
 * must not reach a capture the restricted caller cannot list. Empty allowed
 * set denies every capture; null vendor/PO subsidiaries stay org-wide.
 */
function apCaptureSubsidiaryScope(allowed: ReadonlySet<string> | null) {
  if (allowed === null) return sql``
  if (allowed.size === 0) return sql` and false`
  return sql`${subsidiaryVisibleFilter(sql`po.subsidiary_id`, allowed, { orgWideNull: true })}
             ${subsidiaryVisibleFilter(sql`vendor.subsidiary_id`, allowed, { orgWideNull: true })}`
}

function apCaptureVisibleExists(orgId: string, id: string, allowed: ReadonlySet<string> | null) {
  return sql`exists (
    select 1 from ap_capture_items ci
    left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
    left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
    where ci.org_id = ${orgId} and ci.id = ${id}
    ${apCaptureSubsidiaryScope(allowed)}
  )`
}

export async function POST(request: Request) {
  const gate = await guardPermission('ap.create')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(request, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string; ids?: string[] }
  // Keep the historical 36-character hex/dash collector so a dash-only
  // string is still a named id (not dropped into invalid_action), then
  // refuse it with the same not_found the item routes compute — never bind
  // it into a uuid column.
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 50) : []
  if (!ids.length || !['reprocess', 'reject', 'materialize'].includes(String(body.action))) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
  }
  if (!ids.every(isUuid)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const results: Array<{ id: string; ok: boolean; error?: string; documentId?: string }> = []
  for (const id of ids) {
    try {
      if (body.action === 'reject') {
        await db.transaction(async (tx) => {
          const changed = (await tx.execute<{ id: string }>(sql`
            update ap_capture_items set status = 'rejected', updated_at = now(), updated_by = ${gate.user.id}
             where org_id = ${gate.user.orgId} and id = ${id} and status <> 'materialized'
               and ${apCaptureVisibleExists(gate.user.orgId, id, gate.allowedSubsidiaryIds)}
             returning id
          `))
          if (!changed.rows[0]) throw new Error('not_rejectable')
          await tx.execute(sql`
            insert into ap_capture_events (org_id, capture_item_id, event_kind, actor_id)
            values (${gate.user.orgId}, ${id}, 'rejected', ${gate.user.id})
          `)
        })
        results.push({ id, ok: true })
      } else if (body.action === 'reprocess') {
        await db.transaction(async (tx) => {
          const changed = (await tx.execute<{ id: string }>(sql`
            update ap_capture_items set status = 'queued', last_error = null, updated_at = now(), updated_by = ${gate.user.id}
             where org_id = ${gate.user.orgId} and id = ${id} and status in ('failed','needs_review','ready','duplicate')
               and ${apCaptureVisibleExists(gate.user.orgId, id, gate.allowedSubsidiaryIds)}
             returning id
          `))
          if (!changed.rows[0]) throw new Error('not_reprocessable')
          await tx.execute(sql`
            insert into ap_capture_events (org_id, capture_item_id, event_kind, actor_id)
            values (${gate.user.orgId}, ${id}, 'reprocess_queued', ${gate.user.id})
          `)
        })
        try {
          await enqueueApCapture({ orgId: gate.user.orgId, captureItemId: id, actorId: gate.user.id }, { jobId: `ap-capture|${id}|${Date.now()}` })
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
        `))
        if (!visible.rows[0]) throw new Error('Capture item not found')
        const created = await materializeCapture({ orgId: gate.user.orgId, captureItemId: id, actorId: gate.user.id })
        results.push({ id, ok: true, documentId: created.documentId })
      }
    } catch (error) {
      results.push({ id, ok: false, error: error instanceof Error ? error.message : 'failed' })
    }
  }
  return NextResponse.json({ results })
}
