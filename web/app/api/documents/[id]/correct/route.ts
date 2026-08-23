import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  DocumentVoidError,
  requestDocumentVoid,
} from '@openbooks/engine/src/document-void.ts'
import { deleteDocument } from '@openbooks/engine/src/document-delete.ts'
import { can, getAuthz } from '../../../../../lib/authz'
import {
  createPermission,
  createPostedCorrectionDraft,
  DOC_KINDS,
  isDocKindEnabled,
  DocumentEditError,
  postPermission,
  type DocumentEditInput,
} from '../../../../../lib/documents'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const found = (await db.execute<{ kind: string; status: string }>(sql`
    select kind, status
      from documents
     where id = ${id} and org_id = ${authz.user.orgId}
  `))
  const source = found.rows[0]
  if (!source) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!(await isDocKindEnabled(authz.user.orgId, source.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!DOC_KINDS[source.kind]) {
    return NextResponse.json(
      { error: 'this transaction type uses its dedicated correction workflow' },
      { status: 422 },
    )
  }
  const requiredPermissions = [
    createPermission(source.kind),
    postPermission(source.kind),
  ]
  for (const permission of requiredPermissions) {
    if (!can(authz, permission)) {
      return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 })
    }
  }
  if (source.status !== 'posted') {
    return NextResponse.json({ error: 'only a posted transaction can be corrected' }, { status: 422 })
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as DocumentEditInput
  let replacement: { id: string; documentNumber: string } | null = null
  try {
    replacement = await createPostedCorrectionDraft(id, body, {
      orgId: authz.user.orgId,
      userId: authz.user.id,
      source: 'posted_correction',
    })
    const result = await requestDocumentVoid({
      documentId: id,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      reason: body.amendmentReason ?? '',
      source: 'ui',
    })
    return NextResponse.json(
      {
        ok: true,
        correctionId: replacement.id,
        correctionNumber: replacement.documentNumber,
        voidStatus: result.status,
        requestId: result.runId,
      },
      { status: result.status === 'pending_approval' ? 202 : 201 },
    )
  } catch (error) {
    if (replacement) {
      await deleteDocument(replacement.id, authz.user.id, authz.user.orgId, {
        source: 'posted_correction_rollback',
        reason: 'correction request failed',
      }).catch(() => {})
    }
    if (error instanceof DocumentEditError || error instanceof DocumentVoidError) {
      return NextResponse.json({ error: error.message }, { status: error instanceof DocumentEditError ? error.status : 422 })
    }
    throw error
  }
}
