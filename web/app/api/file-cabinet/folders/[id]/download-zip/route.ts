import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { getFolder } from '../../../../../../lib/file-cabinet'
import { buildZip, folderZipManifest, MAX_ZIP_FILES } from '../../../../../../lib/file-zip'
import { isUuid } from '../../../../../../lib/list-params'
import { fileViewer, requireFolderAccess, requireSession } from '../../../lib'

export const runtime = 'nodejs'

/** Download a folder (and its sub-folders) as a single .zip. Viewer+ required. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const access = await requireFolderAccess(gate, id, 'viewer')
  if (access) return access

  const folder = await getFolder(gate.user.orgId, id)
  if (!folder) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const entries = await folderZipManifest(gate.user.orgId, id)
  if (entries.length === 0) return NextResponse.json({ error: 'folder is empty' }, { status: 404 })
  if (entries.length > MAX_ZIP_FILES) {
    return NextResponse.json(
      { error: `too many files to zip (limit ${MAX_ZIP_FILES})` },
      { status: 413 },
    )
  }

  const { bytes } = await buildZip(gate.user.orgId, fileViewer(gate), entries)
  const stamp = await businessToday(gate.user.orgId)
  const name = `${folder.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/]/g, '_').trim() || 'folder'}-${stamp}.zip`
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
