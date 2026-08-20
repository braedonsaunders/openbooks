import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { enqueueApCapture } from '@openbooks/jobs'
import { db } from '@openbooks/engine/src/db.ts'
import { captureContentMatchesMime } from '@openbooks/engine/src/ap-capture.ts'
import { getDocumentCaptureRuntimeConfig } from '@openbooks/engine/src/ap-capture-config.ts'
import { guardPermission } from '../../../lib/authz'
import { createFile, deleteFile, ensureApCaptureRoot } from '../../../lib/file-cabinet'

export const runtime = 'nodejs'

const MAX_FILES = 50
const MAX_BYTES = 20 * 1024 * 1024
const MAX_BATCH_BYTES = 100 * 1024 * 1024
const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'])

function safeFilename(value: string): string {
  return basename(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240) || 'document'
}

export async function POST(request: Request) {
  const gate = await guardPermission('ap.create')
  if (gate instanceof NextResponse) return gate
  const captureConfig = await getDocumentCaptureRuntimeConfig(gate.user.orgId).catch(() => null)
  if (!captureConfig) return NextResponse.json({ error: 'capture_not_configured' }, { status: 409 })
  const form = await request.formData()
  const files = form.getAll('files').filter((value): value is File => value instanceof File)
  if (files.length === 0) return NextResponse.json({ error: 'no_files' }, { status: 400 })
  if (files.length > MAX_FILES) return NextResponse.json({ error: 'too_many_files', limit: MAX_FILES }, { status: 422 })
  const prepared: Array<{ file: File; bytes: Buffer; filename: string; hash: string }> = []
  let batchBytes = 0
  for (const file of files) {
    if (!ALLOWED.has(file.type)) return NextResponse.json({ error: 'unsupported_type', filename: file.name }, { status: 422 })
    if (file.size <= 0 || file.size > MAX_BYTES) return NextResponse.json({ error: 'invalid_size', filename: file.name }, { status: 422 })
    batchBytes += file.size
    if (batchBytes > MAX_BATCH_BYTES) return NextResponse.json({ error: 'batch_too_large' }, { status: 422 })
    const bytes = Buffer.from(await file.arrayBuffer())
    if (!captureContentMatchesMime(bytes, file.type)) return NextResponse.json({ error: 'content_type_mismatch', filename: file.name }, { status: 422 })
    prepared.push({ file, bytes, filename: safeFilename(file.name), hash: createHash('sha256').update(bytes).digest('hex') })
  }
  const folderId = await ensureApCaptureRoot(gate.user.orgId, gate.user.id)
  const created: string[] = []
  for (const upload of prepared) {
    const stored = await createFile({
      orgId: gate.user.orgId,
      folderId,
      filename: upload.filename,
      contentType: upload.file.type,
      bytes: upload.bytes,
      createdBy: gate.user.id,
    })
    let captureItemId: string
    try {
      captureItemId = await db.transaction(async (tx) => {
        const inserted = (await tx.execute<{ id: string }>(sql`
          insert into ap_capture_items (org_id, file_id, status, source, original_filename,
                                        content_hash, created_by, updated_by)
          values (${gate.user.orgId}, ${stored.id}, 'queued', 'upload', ${upload.filename},
                  ${upload.hash}, ${gate.user.id}, ${gate.user.id})
          returning id
        `))
        const id = inserted.rows[0].id
        await tx.execute(sql`
          insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
          values (${gate.user.orgId}, ${id}, 'uploaded',
                  ${JSON.stringify({ filename: upload.filename, sizeBytes: upload.bytes.length })}::jsonb,
                  ${gate.user.id})
        `)
        return id
      })
    } catch (error) {
      await deleteFile(gate.user.orgId, stored.id).catch(() => false)
      throw error
    }
    try {
      await enqueueApCapture({ orgId: gate.user.orgId, captureItemId, actorId: gate.user.id })
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'queue_unavailable'
      await db.execute(sql`
        update ap_capture_items set status = 'failed', last_error = ${message}, updated_at = now()
         where id = ${captureItemId} and org_id = ${gate.user.orgId}
      `)
    }
    created.push(captureItemId)
  }
  return NextResponse.json({ ids: created }, { status: 201 })
}
