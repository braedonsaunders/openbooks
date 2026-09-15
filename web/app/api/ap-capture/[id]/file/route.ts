import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission, can } from '../../../../../lib/authz'
import { getFileBlob } from '../../../../../lib/file-cabinet'
import { blobResponse } from '../../../../../lib/blob-response'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const capture = (await db.execute<{ file_id: string }>(sql`
    select file_id from ap_capture_items where org_id = ${gate.user.orgId} and id = ${id}
  `))
  const fileId = capture.rows[0]?.file_id
  if (!fileId) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const blob = await getFileBlob(gate.user.orgId, fileId, {
    userId: gate.user.id,
    isAdmin: can(gate, '*'),
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  })
  if (!blob) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return blobResponse(request, blob, { fallbackName: 'document' })
}
