import { isDocumentRevisionToken } from '@openbooks/engine/src/document-revision.ts'
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  DocumentVoidError,
  requestDocumentVoid,
} from '@openbooks/engine/src/document-void.ts'
import { can, getAuthz, guardSubsidiaryScope } from '../../../../../lib/authz'
import { createPermission, isDocKindEnabled, postPermission } from '../../../../../lib/documents'
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
  const found = (await db.execute<{ kind: string; subsidiaryId: string | null }>(sql`
    select kind, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${id} and org_id = ${authz.user.orgId}
  `))
  const doc = found.rows[0]
  if (!doc) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(authz, doc.subsidiaryId)
  if (denied) return denied
  if (!(await isDocKindEnabled(authz.user.orgId, doc.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    reason?: string
    reversalDate?: string | null
    expectedUpdatedAt?: string
  }
  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json({ error: 'Reload the document and supply its exact revision before voiding' }, { status: 409 })
  }
  try {
    const result = await requestDocumentVoid({
      documentId: id,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      reason: body.reason ?? '',
      reversalDate: body.reversalDate,
      source: 'ui',
      expectedUpdatedAt: body.expectedUpdatedAt,
    })
    return NextResponse.json(
      { ok: true, ...result },
      { status: result.status === 'pending_approval' ? 202 : 200 },
    )
  } catch (error) {
    if (error instanceof DocumentVoidError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
