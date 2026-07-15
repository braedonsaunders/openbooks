import { NextResponse } from 'next/server'
import { attachExisting, getFile, listAttachments, uploadAndAttach } from '../../../../lib/file-cabinet'
import { isUuid } from '../../../../lib/list-params'
import { guardPermission } from '../../../../lib/authz'
import { canMutateFiles, fileViewer, isAllowedContentType, MAX_BYTES, requireSession } from '../lib'

export const runtime = 'nodejs'

/** List files attached to a record (metadata only). */
export async function GET(req: Request) {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const targetTable = url.searchParams.get('targetTable') ?? ''
  const targetId = url.searchParams.get('targetId') ?? ''
  if (!targetTable || !isUuid(targetId)) {
    return NextResponse.json({ error: 'targetTable and targetId are required' }, { status: 400 })
  }
  const items = await listAttachments(gate.user.orgId, targetTable, targetId)
  return NextResponse.json({ attachments: items })
}

/**
 * Attach a file to a record. Two modes:
 *   - multipart upload (file + targetTable + targetId): auto-creates a
 *     per-record folder, stores the file, and links it.
 *   - JSON ({ fileId, targetTable, targetId }): links an existing file.
 */
export async function POST(req: Request) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate

  const contentType = req.headers.get('content-type') ?? ''

  if (contentType.startsWith('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 })
    const file = form.get('file')
    const targetTable = String(form.get('targetTable') ?? '')
    const targetId = String(form.get('targetId') ?? '')
    if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
    if (!targetTable || !isUuid(targetId)) {
      return NextResponse.json({ error: 'targetTable and targetId are required' }, { status: 400 })
    }
    if (!canMutateFiles(gate, targetTable)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    if (!isAllowedContentType(file.type)) {
      return NextResponse.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, { status: 415 })
    }
    if (file.size > MAX_BYTES) return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })

    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.length > MAX_BYTES) return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })
    if (bytes.length === 0) return NextResponse.json({ error: 'file is empty' }, { status: 400 })

    const meta = await uploadAndAttach({
      orgId: gate.user.orgId,
      targetTable,
      targetId,
      filename: file.name || 'attachment',
      contentType: file.type.split(';')[0].trim().toLowerCase(),
      bytes,
      createdBy: gate.user.id,
    })
    return NextResponse.json({ attachment: meta }, { status: 201 })
  }

  // JSON mode: attach an existing file
  const body = await req.json().catch(() => null)
  if (!body || !isUuid(body.fileId) || !body.targetTable || !isUuid(body.targetId)) {
    return NextResponse.json({ error: 'fileId, targetTable, and targetId are required' }, { status: 400 })
  }
  if (!canMutateFiles(gate, body.targetTable)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  // The file must belong to the caller's org and be visible to them —
  // blocks cross-org links and attaching out of someone else's private folder.
  if (!(await getFile(gate.user.orgId, body.fileId, fileViewer(gate)))) {
    return NextResponse.json({ error: 'file not found' }, { status: 404 })
  }
  const id = await attachExisting({
    orgId: gate.user.orgId,
    fileId: body.fileId,
    targetTable: body.targetTable,
    targetId: body.targetId,
    createdBy: gate.user.id,
  })
  if (!id) return NextResponse.json({ error: 'already attached' }, { status: 409 })
  return NextResponse.json({ id }, { status: 201 })
}
