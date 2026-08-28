import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import {
  deleteFolder,
  getFolder,
  patchFolder,
  purgeFolder,
} from '../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../lib/list-params'
import { guardPermission } from '../../../../../lib/authz'
import { fileViewer, requireFolderAccess, requireSession } from '../../lib'

export const runtime = 'nodejs'

/** Get a single folder. Private-folder visibility applies: a folder hidden
 *  behind someone else's private boundary reads as not found. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const folder = await getFolder(gate.user.orgId, id, fileViewer(gate))
  if (!folder) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ folder })
}

/** Update a folder (rename, move, toggle private/inactive). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Editing a folder (rename/move/flags) needs Manager on it.
  const access = await requireFolderAccess(gate, id, 'manager')
  if (access) return access
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const patch: {
    parentId?: string | null
    name?: string
    isPrivate?: boolean
    isInactive?: boolean
  } = {}
  if (typeof body.parentId === 'string' || body.parentId === null) {
    // Moving also needs Editor+ on the destination parent.
    if (typeof body.parentId === 'string') {
      const destGate = await requireFolderAccess(gate, body.parentId, 'editor')
      if (destGate) return destGate
    }
    patch.parentId = body.parentId
  }
  if (typeof body.name === 'string' && body.name.trim()) {
    patch.name = body.name.trim()
  }
  if (typeof body.isPrivate === 'boolean') patch.isPrivate = body.isPrivate
  if (typeof body.isInactive === 'boolean') patch.isInactive = body.isInactive
  if (Object.keys(patch).length > 0) {
    const result = await patchFolder(gate.user.orgId, id, patch, gate.user.id, { actorId: gate.user.id })
    if (!result.ok) {
      const status = result.reason === 'not found' ? 404 : 400
      return NextResponse.json({ error: result.reason }, { status })
    }
  }
  return NextResponse.json({ ok: true })
}

/** Delete a folder (fails if it contains attached files). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Deleting a folder needs Manager on it.
  const access = await requireFolderAccess(gate, id, 'manager')
  if (access) return access
  const purge = new URL(req.url).searchParams.get('purge') === '1'
  const audit = { actorId: gate.user.id }
  const result = purge
    ? await purgeFolder(gate.user.orgId, id, audit)
    : await deleteFolder(gate.user.orgId, id, audit)
  if (!result.ok) {
    const status =
      result.reason === 'not found' ? 404 : result.reason === 'system' ? 400 : 409
    return NextResponse.json({ error: result.reason }, { status })
  }
  return NextResponse.json({ ok: true })
}
