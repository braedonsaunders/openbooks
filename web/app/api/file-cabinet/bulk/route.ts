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
import { inDbTransaction } from '@openbooks/engine/src/platform/db.ts'
import { isUuid } from '../../../../lib/list-params'
import { fileViewer, requireSession } from '../lib'

export const runtime = 'nodejs'

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && isUuid(x)) : []
}

type BulkItemResult = { id: string; kind: 'file' | 'folder'; ok: boolean; error?: string }

/**
 * Bulk file/folder actions. Body:
 *   { action: 'delete' | 'move', fileIds?, folderIds?, targetFolderId? }
 * Access is checked per item (unauthorized items are skipped, not fatal); the
 * response reports how many succeeded AND the verdict per requested id, so
 * the caller can keep exactly the refused rows selected instead of reporting
 * a partial bulk as full success.
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
    const results: BulkItemResult[] = []
    const audit = { actorId: gate.user.id, executor: tx, viewer }
    const record = (id: string, kind: 'file' | 'folder', ok: boolean, error?: string) => {
      if (ok) done++
      else skipped++
      results.push(error ? { id, kind, ok, error } : { id, kind, ok })
    }

    if (action === 'move') {
      for (const id of fileIds) {
        if (!accessAtLeast(await fileAccessLevel(orgId, viewer, id), 'editor')) { record(id, 'file', false, 'forbidden'); continue }
        if (await moveFile(orgId, id, targetFolderId!, gate.user.id, audit)) record(id, 'file', true)
        else record(id, 'file', false, 'failed')
      }
      for (const id of folderIds) {
        if (!accessAtLeast(await folderAccessLevel(orgId, viewer, id), 'manager')) { record(id, 'folder', false, 'forbidden'); continue }
        if (await moveFolder(orgId, id, targetFolderId!, gate.user.id, audit)) record(id, 'folder', true)
        else record(id, 'folder', false, 'failed')
      }
    } else {
      // delete → trash
      for (const id of fileIds) {
        if (!accessAtLeast(await fileAccessLevel(orgId, viewer, id), 'manager')) { record(id, 'file', false, 'forbidden'); continue }
        if (await deleteFile(orgId, id, audit)) record(id, 'file', true)
        else record(id, 'file', false, 'failed')
      }
      for (const id of folderIds) {
        if (!accessAtLeast(await folderAccessLevel(orgId, viewer, id), 'manager')) { record(id, 'folder', false, 'forbidden'); continue }
        const res = await deleteFolder(orgId, id, audit)
        if (res.ok) record(id, 'folder', true)
        else record(id, 'folder', false, res.reason === 'not found' ? 'not_found' : res.reason ?? 'failed')
      }
    }

    return { done, skipped, results }
  })

  return NextResponse.json({ ok: true, ...result })
}
