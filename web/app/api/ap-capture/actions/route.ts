import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { enqueueApCapture } from '@openbooks/jobs'
import { db } from '@openbooks/engine/src/db.ts'
import { materializeCapture } from '@openbooks/engine/src/ap-capture-service.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const gate = await guardPermission('ap.create')
  if (gate instanceof NextResponse) return gate
  const body = (await request.json().catch(() => ({}))) as { action?: string; ids?: string[] }
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(0, 50) : []
  if (!ids.length || !['reprocess', 'reject', 'materialize'].includes(String(body.action))) {
    return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
  }
  const results: Array<{ id: string; ok: boolean; error?: string; documentId?: string }> = []
  for (const id of ids) {
    try {
      if (body.action === 'reject') {
        await db.transaction(async (tx) => {
          const changed = (await tx.execute<{ id: string }>(sql`
            update ap_capture_items set status = 'rejected', updated_at = now(), updated_by = ${gate.user.id}
             where org_id = ${gate.user.orgId} and id = ${id} and status <> 'materialized' returning id
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
             where org_id = ${gate.user.orgId} and id = ${id} and status in ('failed','needs_review','ready','duplicate') returning id
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
        const created = await materializeCapture({ orgId: gate.user.orgId, captureItemId: id, actorId: gate.user.id })
        results.push({ id, ok: true, documentId: created.documentId })
      }
    } catch (error) {
      results.push({ id, ok: false, error: error instanceof Error ? error.message : 'failed' })
    }
  }
  return NextResponse.json({ results })
}
