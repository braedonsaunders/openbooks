import { defineRoute } from '@/lib/api/route'
import { z } from 'zod'
import { apiErrorResponse } from '@/lib/api/error-response'
import 'next/server';
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { withScopeSnapshot } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { can } from '../../../../../lib/authz';
import { isMaskedFileContentError } from '../../../../../lib/file-storage'
import { getFileBlob } from '../../../../../lib/file-cabinet'
import { blobResponse } from '../../../../../lib/blob-response'
import { isUuid } from '../../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { notFound } from "@/lib/api/responses";


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

export const GET = defineRoute({
  permission: 'ap.read',
  feature: { none: 'No optional feature applies to this permission-governed endpoint.' },
  params: z.object({ "id": z.string() }),
  handler: async ({ request: request, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    return withScopeSnapshot(gate.user.orgId, async () => {
    const capture = (await db.execute<{ file_id: string }>(sql`
      select ci.file_id
        from ap_capture_items ci
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
       ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)}
    `))
    const fileId = capture.rows[0]?.file_id
    if (!fileId) return notFound("record")
    let blob: Awaited<ReturnType<typeof getFileBlob>>
    try {
      blob = await getFileBlob(gate.user.orgId, fileId, {
        userId: gate.user.id,
        isAdmin: can(gate, '*'),
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
    } catch (err) {
      // Masked-clone tombstone: refuse by name, never as an anonymous 500.
      if (isMaskedFileContentError(err)) {
        return apiErrorResponse(err, { safeStatus: 403 })
      }
      throw err
    }
    if (!blob) return notFound("record")
    return blobResponse(request, blob, { fallbackName: 'document' })
    })

  },
})
