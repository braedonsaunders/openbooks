import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission, can } from '../../../../../lib/authz'
import { getFileBlob } from '../../../../../lib/file-cabinet'
import { blobResponse } from '../../../../../lib/blob-response'
import { isUuid } from '../../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'

export const runtime = 'nodejs'

/**
 * Same vendor/PO visibility the inbox list and `?capture=` flyout apply
 * (`web/app/(app)/ap/capture/view.ts`). Capture packets live in the org-wide
 * `ap_capture` folder, so the cabinet fence cannot hide them — this query
 * must. Empty allowed set denies every capture; null vendor/PO stay org-wide.
 */
function apCaptureSubsidiaryScope(allowed: ReadonlySet<string> | null) {
  if (allowed === null) return sql``
  if (allowed.size === 0) return sql` and false`
  return sql`${subsidiaryVisibleFilter(sql`po.subsidiary_id`, allowed, { orgWideNull: true })}
             ${subsidiaryVisibleFilter(sql`vendor.subsidiary_id`, allowed, { orgWideNull: true })}`
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const capture = (await db.execute<{ file_id: string }>(sql`
    select ci.file_id
      from ap_capture_items ci
      left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
      left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
     where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
     ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)}
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
