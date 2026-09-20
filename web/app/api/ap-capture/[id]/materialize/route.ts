import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { materializeCapture, CaptureMaterializationError } from '@openbooks/engine/src/payables/ap-capture-service.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'

export const runtime = 'nodejs'

/**
 * Same vendor/PO visibility the inbox list and `?capture=` flyout apply
 * (`web/app/(app)/ap/capture/view.ts`). materializeCapture has no subsidiary
 * argument and always posts to the org root, so the route must refuse an
 * out-of-scope capture before the engine runs. A miss uses the engine's
 * missing-item shape so hidden and nonexistent stay indistinguishable.
 */
function apCaptureSubsidiaryScope(allowed: ReadonlySet<string> | null) {
  if (allowed === null) return sql``
  if (allowed.size === 0) return sql` and false`
  return sql`${subsidiaryVisibleFilter(sql`po.subsidiary_id`, allowed, { orgWideNull: true })}
             ${subsidiaryVisibleFilter(sql`vendor.subsidiary_id`, allowed, { orgWideNull: true })}`
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.create')
  if (gate instanceof NextResponse) return gate
  try {
    const { id } = await params
    // The engine binds the id into a uuid column without validating it; a
    // malformed id must 404 here instead of escaping as a cast-error 500.
    if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const visible = (await db.execute<{ id: string }>(sql`
      select ci.id
        from ap_capture_items ci
        left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
        left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
       where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
       ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)}
    `))
    if (!visible.rows[0]) return NextResponse.json({ error: 'Capture item not found' }, { status: 422 })
    return NextResponse.json(await materializeCapture({ orgId: gate.user.orgId, captureItemId: id, actorId: gate.user.id }))
  } catch (error) {
    if (error instanceof CaptureMaterializationError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
