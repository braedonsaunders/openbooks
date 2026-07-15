import { NextResponse } from 'next/server'
import { deleteFile, getFile, moveFile, renameFile } from '../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../lib/list-params'
import { guardPermission } from '../../../../../lib/authz'
import { canMutateFiles, fileViewer, requireSession } from '../../lib'

export const runtime = 'nodejs'

/** Get file details (metadata + versions + attachment links). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const file = await getFile(gate.user.orgId, id, fileViewer(gate))
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ file })
}

/** Rename or move a file. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  if (!canMutateFiles(gate)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  if (typeof body.name === 'string' && body.name.trim()) {
    const ok = await renameFile(gate.user.orgId, id, body.name.trim(), gate.user.id)
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (typeof body.folderId === 'string') {
    if (!isUuid(body.folderId)) {
      return NextResponse.json({ error: 'invalid folderId' }, { status: 400 })
    }
    const ok = await moveFile(gate.user.orgId, id, body.folderId, gate.user.id)
    if (!ok) return NextResponse.json({ error: 'cannot move file' }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}

/** Delete a file (cascades to versions, blobs, and attachment links). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  if (!canMutateFiles(gate)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const ok = await deleteFile(gate.user.orgId, id)
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
