import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { inDbTransaction } from '@openbooks/engine/src/platform/db.ts'
import { deleteFile, getFile, moveFile, purgeFile, renameFile } from '../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../lib/list-params'
import { guardPermission } from '../../../../../lib/authz'
import { fileViewer, requireFileAccess, requireFolderAccess, requireSession } from '../../lib'

export const runtime = 'nodejs'

/** Abort a multi-verb file edit so the shared transaction rolls everything back. */
class FilePatchAbort extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FilePatchAbort'
    this.status = status
  }
}

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

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null
  const folderId = typeof body.folderId === 'string' ? body.folderId : null
  // Every refusal is decided BEFORE anything commits: the rename and the move
  // below share one transaction, so a refused move can never leave a rename
  // behind (and a refused rename never reaches the move).
  if (folderId !== null && !isUuid(folderId)) {
    return NextResponse.json({ error: 'invalid folderId' }, { status: 400 })
  }
  if (folderId !== null) {
    // Moving also needs Editor+ on the destination folder.
    const destGate = await requireFolderAccess(gate, folderId, 'editor')
    if (destGate) return destGate
  }
  if (name === null && folderId === null) return NextResponse.json({ ok: true })
  try {
    await inDbTransaction(async (tx) => {
      const audit = { actorId: gate.user.id, executor: tx }
      if (name !== null) {
        // The verb commits the rename and its attributable audit atomically.
        const ok = await renameFile(gate.user.orgId, id, name, gate.user.id, audit)
        if (!ok) throw new FilePatchAbort(404, 'not found')
      }
      if (folderId !== null) {
        const ok = await moveFile(gate.user.orgId, id, folderId, gate.user.id, audit)
        if (!ok) throw new FilePatchAbort(400, 'cannot move file')
      }
    })
  } catch (error) {
    if (error instanceof FilePatchAbort) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
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
