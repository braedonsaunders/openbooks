import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission, can } from '../../../../../lib/authz'
import { getFileBlob } from '../../../../../lib/file-cabinet'

export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const capture = (await db.execute(sql`
    select file_id from ap_capture_items where org_id = ${gate.user.orgId} and id = ${id}
  `)) as unknown as { rows: { file_id: string }[] }
  const fileId = capture.rows[0]?.file_id
  if (!fileId) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const blob = await getFileBlob(gate.user.orgId, fileId, {
    userId: gate.user.id,
    isAdmin: can(gate, '*'),
  })
  if (!blob) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const name = blob.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'document'
  const bytes = new Uint8Array(blob.bytes)
  return new NextResponse(bytes, {
    headers: {
      'Content-Type': blob.contentType,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `inline; filename="${name}"; filename*=UTF-8''${encodeURIComponent(blob.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  })
}
