import { NextResponse } from 'next/server'
import { replaceFile } from '../../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../../lib/list-params'
import { recordFileEvent } from '../../../../../../lib/file-audit'
import { isAllowedContentType, MAX_BYTES, requireFileAccess, requireSession } from '../../../lib'

export const runtime = 'nodejs'

/** Upload a new version of a file (the old version is preserved). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Replacing (new version) needs Editor+ on the file.
  const access = await requireFileAccess(gate, id, 'editor')
  if (access) return access

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 })
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
  if (!isAllowedContentType(file.type)) {
    return NextResponse.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, { status: 415 })
  }
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })

  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length > MAX_BYTES) return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })
  if (bytes.length === 0) return NextResponse.json({ error: 'file is empty' }, { status: 400 })

  const ok = await replaceFile({
    orgId: gate.user.orgId,
    fileId: id,
    filename: file.name || 'file',
    contentType: file.type.split(';')[0]!.trim().toLowerCase(),
    bytes,
    updatedBy: gate.user.id,
  })
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await recordFileEvent({
    orgId: gate.user.orgId,
    actorId: gate.user.id,
    table: 'files',
    rowId: id,
    action: 'replace',
    changes: { name: file.name || 'file' },
  })
  return NextResponse.json({ ok: true })
}
