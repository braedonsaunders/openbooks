import { isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  DocumentVoidError,
  requestDocumentVoid,
} from '@openbooks/engine/src/ledger/document-void.ts'
import { can, getAuthz, guardSubsidiaryScope } from '../../../../../lib/authz'
import { createPermission, postPermission } from "../../../../../lib/document-kinds.ts";
import { isDocKindEnabled } from "../../../../../lib/documents.ts";
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

type VoidGuard = { authz: NonNullable<Awaited<ReturnType<typeof getAuthz>>>; id: string }

/** The caller may drive this document's void — shared by GET and POST. */
async function guardVoidDocument(id: string): Promise<VoidGuard | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
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
  return { authz, id }
}

/**
 * Adjustment periods eligible as an explicit void-reversal override. Empty
 * when the org uses none — the void UI then offers no period choice and the
 * reversal resolves by date in the regular covering period.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const gate = await guardVoidDocument(id)
  if (gate instanceof NextResponse) return gate
  const periods = (await db.execute<{ id: string; name: string; startsOn: string; endsOn: string }>(sql`
    select p.id, p.name, p.starts_on::text as "startsOn", p.ends_on::text as "endsOn"
      from accounting_periods p
      join fiscal_calendars fc
        on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       and fc.is_default and fc.is_active
     where p.org_id = ${gate.authz.user.orgId} and p.is_adjustment
     order by p.starts_on, p.ends_on, p.id
  `))
  return NextResponse.json({ adjustmentPeriods: periods.rows })
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const gate = await guardVoidDocument(id)
  if (gate instanceof NextResponse) return gate
  const { authz } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    reason?: string
    reversalDate?: string | null
    reversalPeriodId?: string | null
    expectedUpdatedAt?: string
  }
  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json(
      { error: 'Reload the document and supply its exact revision before voiding', code: 'stale-revision' },
      { status: 409 },
    )
  }
  try {
    const result = await requestDocumentVoid({
      documentId: id,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      reason: body.reason ?? '',
      reversalDate: body.reversalDate,
      reversalPeriodId: body.reversalPeriodId,
      source: 'ui',
      expectedUpdatedAt: body.expectedUpdatedAt,
    })
    return NextResponse.json(
      { ok: true, ...result },
      { status: result.status === 'pending_approval' ? 202 : 200 },
    )
  } catch (error) {
    if (error instanceof DocumentVoidError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    throw error
  }
}
