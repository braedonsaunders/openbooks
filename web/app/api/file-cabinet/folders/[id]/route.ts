import { NextResponse } from 'next/server'
import {
  deleteFolder,
  getFolder,
  moveFolder,
  renameFolder,
  updateFolder,
} from '../../../../../lib/file-cabinet'
import { isUuid } from '../../../../../lib/list-params'
import { guardPermission } from '../../../../../lib/authz'
import { canMutateFiles, requireSession } from '../../lib'

export const runtime = 'nodejs'

/** Get a single folder. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const folder = await getFolder(gate.user.orgId, id)
  if (!folder) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ folder })
}

/** Update a folder (rename, move, toggle private/inactive). */
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

  if (typeof body.parentId === 'string' || body.parentId === null) {
    const ok = await moveFolder(gate.user.orgId, id, body.parentId, gate.user.id)
    if (!ok) return NextResponse.json({ error: 'cannot move folder' }, { status: 400 })
  }
  if (typeof body.name === 'string' && body.name.trim()) {
    const ok = await renameFolder(gate.user.orgId, id, body.name.trim(), gate.user.id)
    if (!ok) return NextResponse.json({ error: 'cannot rename system folder' }, { status: 400 })
  }
  const patch: { isPrivate?: boolean; isInactive?: boolean } = {}
  if (typeof body.isPrivate === 'boolean') patch.isPrivate = body.isPrivate
  if (typeof body.isInactive === 'boolean') patch.isInactive = body.isInactive
  if (Object.keys(patch).length > 0) {
    await updateFolder(gate.user.orgId, id, patch, gate.user.id)
  }
  return NextResponse.json({ ok: true })
}

/** Delete a folder (fails if it contains attached files). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  if (!canMutateFiles(gate)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const result = await deleteFolder(gate.user.orgId, id)
  if (!result.ok) {
    const status =
      result.reason === 'not found' ? 404 : result.reason === 'system' ? 400 : 409
    return NextResponse.json({ error: result.reason }, { status })
  }
  return NextResponse.json({ ok: true })
}
