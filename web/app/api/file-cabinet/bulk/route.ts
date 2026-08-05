import { NextResponse } from 'next/server'
import {
  accessAtLeast,
  deleteFile,
  deleteFolder,
  fileAccessLevel,
  folderAccessLevel,
  moveFile,
  moveFolder,
} from '../../../../lib/file-cabinet'
import { recordFileEvent } from '../../../../lib/file-audit'
import { isUuid } from '../../../../lib/list-params'
import { fileViewer, requireSession } from '../lib'

export const runtime = 'nodejs'

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isUuid(x)) : []
}

/**
 * Bulk file/folder actions. Body:
 *   { action: 'delete' | 'move', fileIds?, folderIds?, targetFolderId? }
 * Access is checked per item (unauthorized items are skipped, not fatal); the
 * response reports how many succeeded.
 */
export async function POST(req: Request) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const viewer = fileViewer(gate)

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const action = body?.action
  const fileIds = idList(body?.fileIds)
  const folderIds = idList(body?.folderIds)
  if (action !== 'delete' && action !== 'move') {
    return NextResponse.json({ error: 'action must be delete or move' }, { status: 400 })
  }
  if (fileIds.length === 0 && folderIds.length === 0) {
    return NextResponse.json({ error: 'nothing selected' }, { status: 400 })
  }

  let done = 0
  let skipped = 0

  if (action === 'move') {
    const targetFolderId = body?.targetFolderId
    if (typeof targetFolderId !== 'string' || !isUuid(targetFolderId)) {
      return NextResponse.json({ error: 'valid targetFolderId is required' }, { status: 400 })
    }
    // Destination needs Editor+.
    if (!accessAtLeast(await folderAccessLevel(orgId, viewer, targetFolderId), 'editor')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    for (const id of fileIds) {
      if (!accessAtLeast(await fileAccessLevel(orgId, viewer, id), 'editor')) { skipped++; continue }
      if (await moveFile(orgId, id, targetFolderId, gate.user.id)) {
        done++
        await recordFileEvent({ orgId, actorId: gate.user.id, table: 'files', rowId: id, action: 'move', changes: { folderId: targetFolderId } })
      } else skipped++
    }
    for (const id of folderIds) {
      if (!accessAtLeast(await folderAccessLevel(orgId, viewer, id), 'manager')) { skipped++; continue }
      if (await moveFolder(orgId, id, targetFolderId, gate.user.id)) {
        done++
        await recordFileEvent({ orgId, actorId: gate.user.id, table: 'folders', rowId: id, action: 'move', changes: { parentId: targetFolderId } })
      } else skipped++
    }
  } else {
    // delete → trash
    for (const id of fileIds) {
      if (!accessAtLeast(await fileAccessLevel(orgId, viewer, id), 'manager')) { skipped++; continue }
      if (await deleteFile(orgId, id)) {
        done++
        await recordFileEvent({ orgId, actorId: gate.user.id, table: 'files', rowId: id, action: 'delete', changes: { permanent: false } })
      } else skipped++
    }
    for (const id of folderIds) {
      if (!accessAtLeast(await folderAccessLevel(orgId, viewer, id), 'manager')) { skipped++; continue }
      const res = await deleteFolder(orgId, id)
      if (res.ok) {
        done++
        await recordFileEvent({ orgId, actorId: gate.user.id, table: 'folders', rowId: id, action: 'delete', changes: { permanent: false } })
      } else skipped++
    }
  }

  return NextResponse.json({ ok: true, done, skipped })
}
