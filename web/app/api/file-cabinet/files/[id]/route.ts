import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { deleteFile, getFile, moveFile, purgeFile, renameFile } from '../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../lib/list-params'
import { guardPermission } from '../../../../../lib/authz'
import { fileViewer, requireFileAccess, requireFolderAccess, requireSession } from '../../lib'

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
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Editing (rename/move) a file needs Editor+ on it.
  const gateAccess = await requireFileAccess(gate, id, 'editor')
  if (gateAccess) return gateAccess
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  if (typeof body.name === 'string' && body.name.trim()) {
    // The verb commits the rename and its attributable audit atomically.
    const ok = await renameFile(gate.user.orgId, id, body.name.trim(), gate.user.id, {
      actorId: gate.user.id,
    })
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (typeof body.folderId === 'string') {
    if (!isUuid(body.folderId)) {
      return NextResponse.json({ error: 'invalid folderId' }, { status: 400 })
    }
    // Moving also needs Editor+ on the destination folder.
    const destGate = await requireFolderAccess(gate, body.folderId, 'editor')
    if (destGate) return destGate
    const ok = await moveFile(gate.user.orgId, id, body.folderId, gate.user.id, {
      actorId: gate.user.id,
    })
    if (!ok) return NextResponse.json({ error: 'cannot move file' }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}

/** Trash a file (soft-delete), or permanently delete it with `?purge=1`. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Deleting needs Manager on the file.
  const gateAccess = await requireFileAccess(gate, id, 'manager')
  if (gateAccess) return gateAccess
  const purge = new URL(req.url).searchParams.get('purge') === '1'
  // The verb commits the mutation and its attributable audit atomically (for
  // purge, before any post-commit S3 deletion).
  const audit = { actorId: gate.user.id }
  const ok = purge
    ? await purgeFile(gate.user.orgId, id, audit)
    : await deleteFile(gate.user.orgId, id, audit)
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
