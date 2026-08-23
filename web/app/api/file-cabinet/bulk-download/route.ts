import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { guardPermission } from '../../../../lib/authz'
import { buildZip, filesZipManifest, MAX_ZIP_FILES } from '../../../../lib/file-zip'
import { fileViewer } from '../lib'

export const runtime = 'nodejs'

/** Zip a set of selected files. Per-file visibility is enforced while building
 *  (unreadable files are skipped). Body: { fileIds: string[] }. */
export async function POST(req: Request) {
  const gate = await guardPermission('documents.read')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { fileIds?: unknown } | null
  const fileIds = Array.isArray(body?.fileIds)
    ? body!.fileIds.filter((x): x is string => typeof x === 'string')
    : []
  if (fileIds.length === 0) return NextResponse.json({ error: 'no files selected' }, { status: 400 })
  if (fileIds.length > MAX_ZIP_FILES) {
    return NextResponse.json({ error: `too many files (limit ${MAX_ZIP_FILES})` }, { status: 413 })
  }

  const entries = await filesZipManifest(gate.user.orgId, fileIds)
  const { bytes, included } = await buildZip(gate.user.orgId, fileViewer(gate), entries)
  if (included === 0) return NextResponse.json({ error: 'nothing to download' }, { status: 404 })

  const stamp = await businessToday(gate.user.orgId)
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="files-${stamp}.zip"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
