import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  DocumentVoidError,
  requestDocumentVoid,
} from '@openbooks/engine/src/document-void.ts'
import { can, getAuthz } from '../../../../../lib/authz'
import { createPermission, postPermission } from '../../../../../lib/documents'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

function voidPermission(kind: string): string | null {
  if (kind === 'vendor_payment') return 'ap.pay'
  if (kind === 'customer_payment') return 'ar.pay'
  if (kind === 'journal') return 'gl.post'
  if (kind === 'expense_report') return 'ap.post'
  if (kind === 'purchase_order') return 'ap.create'
  if (kind === 'sales_order' || kind === 'quote') return 'ar.create'
  try {
    return postPermission(kind)
  } catch {
    try {
      return createPermission(kind)
    } catch {
      return null
    }
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const found = (await db.execute<{ kind: string }>(sql`
    select kind
      from documents
     where id = ${id} and org_id = ${authz.user.orgId}
  `))
  const doc = found.rows[0]
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const permission = voidPermission(doc.kind)
  if (!permission) {
    return NextResponse.json(
      { error: 'this transaction type uses its dedicated void workflow' },
      { status: 422 },
    )
  }
  if (!can(authz, permission)) {
    return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    reason?: string
    reversalDate?: string | null
  }
  try {
    const result = await requestDocumentVoid({
      documentId: id,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      reason: body.reason ?? '',
      reversalDate: body.reversalDate,
      source: 'ui',
    })
    return NextResponse.json(
      { ok: true, ...result },
      { status: result.status === 'pending_approval' ? 202 : 200 },
    )
  } catch (error) {
    if (error instanceof DocumentVoidError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}
