import { NextResponse } from 'next/server'
import { createAttachment, listAttachments } from '../../../lib/attachments'
import { isUuid } from '../../../lib/list-params'
import {
  MAX_BYTES,
  canMutateAttachments,
  isAllowedContentType,
  requireSession,
} from './lib'

export const runtime = 'nodejs'

/** List attachment metadata for a target record (no bytes). */
export async function GET(req: Request) {
  const gate = await requireSession()
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

/** Upload a file (multipart/form-data: file + targetTable + targetId). */
export async function POST(req: Request) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate

  const form = await req.formData().catch(() => null)
  if (!form) {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 })
  }
  const file = form.get('file')
  const targetTable = String(form.get('targetTable') ?? '')
  const targetId = String(form.get('targetId') ?? '')

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 })
  }
  if (!targetTable || !isUuid(targetId)) {
    return NextResponse.json({ error: 'targetTable and targetId are required' }, { status: 400 })
  }
  if (!canMutateAttachments(gate, targetTable)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!isAllowedContentType(file.type)) {
    return NextResponse.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  // Trust the measured length, not the client-declared size, for the 25 MB cap.
  if (bytes.length > MAX_BYTES) {
    return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })
  }
  if (bytes.length === 0) {
    return NextResponse.json({ error: 'file is empty' }, { status: 400 })
  }

  const meta = await createAttachment({
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
