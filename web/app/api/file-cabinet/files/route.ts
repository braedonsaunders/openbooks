import { NextResponse } from 'next/server'
import { getFolder, listFiles } from '../../../../lib/file-cabinet'
import { isUuid, pickString } from '../../../../lib/list-params'
import { guardPermission } from '../../../../lib/authz'
import {
  fileViewer,
  isAllowedContentType,
  MAX_BYTES,
  requireFolderAccess,
  requireSession,
} from '../lib'

export const runtime = 'nodejs'

/** List files (optionally filtered by folder, with search + pagination). */
export async function GET(req: Request) {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const folderId = url.searchParams.get('folderId')
  const q = url.searchParams.get('q') ?? undefined
  const sort = url.searchParams.get('sort') ?? 'name'
  const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc'
  const perPageRaw = Number(url.searchParams.get('perPage') ?? '50')
  const limit = Number.isFinite(perPageRaw) ? Math.min(Math.max(Math.trunc(perPageRaw), 1), 100) : 50
  const pageRaw = Number(url.searchParams.get('page') ?? '1')
  const page = Number.isFinite(pageRaw) ? Math.max(Math.trunc(pageRaw), 1) : 1

  if (folderId && !isUuid(folderId)) {
    return NextResponse.json({ error: 'invalid folderId' }, { status: 400 })
  }
  const { files, total } = await listFiles(gate.user.orgId, fileViewer(gate), {
    folderId: folderId ?? undefined,
    q: q ?? undefined,
    sort,
    dir: dir as 'asc' | 'desc',
    limit,
    offset: (page - 1) * limit,
  })
  return NextResponse.json({ files, total, page, perPage: limit })
}

/** Upload a file to a folder (multipart/form-data: file + folderId). */
export async function POST(req: Request) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 })
  const file = form.get('file')
  const folderId = String(form.get('folderId') ?? '')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file is required' }, { status: 400 })
  if (!isUuid(folderId)) return NextResponse.json({ error: 'valid folderId is required' }, { status: 400 })
  // Destination folder must belong to the caller's org.
  if (!(await getFolder(gate.user.orgId, folderId))) {
    return NextResponse.json({ error: 'folder not found' }, { status: 404 })
  }
  // Uploading needs Editor+ on the destination folder.
  const access = await requireFolderAccess(gate, folderId, 'editor')
  if (access) return access
  if (!isAllowedContentType(file.type)) {
    return NextResponse.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, { status: 415 })
  }
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })

  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length > MAX_BYTES) return NextResponse.json({ error: 'file exceeds 25 MB limit' }, { status: 413 })
  if (bytes.length === 0) return NextResponse.json({ error: 'file is empty' }, { status: 400 })

  const { createFile } = await import('../../../../lib/file-cabinet')
  const meta = await createFile({
    orgId: gate.user.orgId,
    folderId,
    filename: file.name || 'file',
    contentType: file.type.split(';')[0].trim().toLowerCase(),
    bytes,
    createdBy: gate.user.id,
  })
  return NextResponse.json({ file: meta }, { status: 201 })
}
