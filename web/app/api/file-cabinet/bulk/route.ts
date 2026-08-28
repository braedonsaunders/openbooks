import { jsonObject, parseJsonBody } from "@/lib/api/json";
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
import { inDbTransaction } from '@openbooks/engine/src/db.ts'
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

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown> | null
  const action = body?.action
  const fileIds = idList(body?.fileIds)
  const folderIds = idList(body?.folderIds)
  if (action !== 'delete' && action !== 'move') {
    return NextResponse.json({ error: 'action must be delete or move' }, { status: 400 })
  }
  if (fileIds.length === 0 && folderIds.length === 0) {
    return NextResponse.json({ error: 'nothing selected' }, { status: 400 })
  }

  let targetFolderId: string | null = null
  if (action === 'move') {
    const candidate = body?.targetFolderId
    if (typeof candidate !== 'string' || !isUuid(candidate)) {
      return NextResponse.json({ error: 'valid targetFolderId is required' }, { status: 400 })
    }
    targetFolderId = candidate
    // Destination needs Editor+.
    if (!accessAtLeast(await folderAccessLevel(orgId, viewer, targetFolderId), 'editor')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  const result = await inDbTransaction(async (tx) => {
    let done = 0
    let skipped = 0
    const audit = { actorId: gate.user.id, executor: tx }

    if (action === 'move') {
      for (const id of fileIds) {
        if (!accessAtLeast(await fileAccessLevel(orgId, viewer, id), 'editor')) { skipped++; continue }
        if (await moveFile(orgId, id, targetFolderId!, gate.user.id, audit)) done++
        else skipped++
      }
      for (const id of folderIds) {
        if (!accessAtLeast(await folderAccessLevel(orgId, viewer, id), 'manager')) { skipped++; continue }
        if (await moveFolder(orgId, id, targetFolderId!, gate.user.id, audit)) done++
        else skipped++
      }
    } else {
      // delete → trash
      for (const id of fileIds) {
        if (!accessAtLeast(await fileAccessLevel(orgId, viewer, id), 'manager')) { skipped++; continue }
        if (await deleteFile(orgId, id, audit)) done++
        else skipped++
      }
      for (const id of folderIds) {
        if (!accessAtLeast(await folderAccessLevel(orgId, viewer, id), 'manager')) { skipped++; continue }
        const res = await deleteFolder(orgId, id, audit)
        if (res.ok) done++
        else skipped++
      }
    }

    return { done, skipped }
  })

  return NextResponse.json({ ok: true, ...result })
}
