import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import {
  DocumentVoidError,
  requestDocumentVoid,
} from '@openbooks/engine/src/ledger/document-void.ts'
import { can, getAuthz, guardSubsidiaryScope, subsidiariesInScope } from '../../../../../lib/authz'
import { createPermission, DOC_KINDS, postPermission } from "../../../../../lib/document-kinds.ts";
import { canReadDocumentKind } from "../../../../../lib/flow-subject-authz.ts";
import { lockedDocumentScopeDenied } from "../../../../../lib/document-scope.ts";
import { createPostedCorrectionDraft, runPostedCorrectionDraftFlows, isDocKindEnabled } from "../../../../../lib/documents.ts";
import { DocumentEditError } from "../../../../../../engine/src/records/document-edit-policy.ts";
import { type DocumentEditInput } from "../../../../../../engine/src/ledger/document-input.ts";
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
  const found = (await db.execute<{ kind: string; status: string; subsidiaryId: string | null }>(sql`
    select kind, status, subsidiary_id as "subsidiaryId"
      from documents
     where id = ${id} and org_id = ${authz.user.orgId}
  `))
  const source = found.rows[0]
  if (!source) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(authz, source.subsidiaryId)
  if (denied) return denied
  if (!(await isDocKindEnabled(authz.user.orgId, source.kind))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!DOC_KINDS[source.kind]) {
    return NextResponse.json(
      { error: 'this transaction type uses its dedicated correction workflow' },
      { status: 422 },
    )
  }
  // Read before correction: without the kind's read grant the record
  // answers as missing, like GET /api/documents/[id].
  if (!canReadDocumentKind(authz, source.kind)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
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
  // The replacement draft inherits the source's subsidiary unless the body
  // re-homes it; either way it must stay inside the caller's scope.
  if (body.subsidiaryId !== undefined && !subsidiariesInScope(authz, [body.subsidiaryId])) {
    return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
  }
  let outcome: {
    replacement: { id: string; documentNumber: string }
    result: { status: 'voided' | 'pending_approval'; runId: string | null }
  }
  try {
    // The replacement draft (and its mandatory `reverses` evidence) plus the
    // source's controlled void are one atomic unit. A void that fails for any
    // reason — a pending void claim, reconciliation, applied payments, a
    // closed reversal period, a before_void veto — rolls the replacement and
    // its lineage back with it, so the source can never be left carrying a
    // correction edge while it is still posted.
    outcome = await withOrgTransaction(authz.user.orgId, async () => {
      // Locked scope recheck: a rehome that landed after the precheck
      // must not let this unit correct-and-void another subsidiary's
      // document. The replacement draft and the controlled void below
      // share this transaction, so the lock covers both.
      const relocked = await lockedDocumentScopeDenied(authz, id)
      // DocumentEditError (not the void error) so the refusal keeps the
      // uniform missing shape — no extra code field to tell it apart.
      if (relocked) throw new DocumentEditError(404, 'not found')
      const replacement = await createPostedCorrectionDraft(id, body, {
        orgId: authz.user.orgId,
        userId: authz.user.id,
        source: 'posted_correction',
      }, { deferFlows: true })
      const result = await requestDocumentVoid({
        documentId: id,
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        reason: body.amendmentReason ?? '',
        source: 'ui',
      })
      return { replacement, result }
    })
    // Flow plans may enqueue email or other externally visible work; dispatch
    // only after the atomic unit above has committed.
    await runPostedCorrectionDraftFlows(outcome.replacement.id, source.kind, {
      orgId: authz.user.orgId,
      userId: authz.user.id,
      source: 'posted_correction',
    })
    return NextResponse.json(
      {
        ok: true,
        correctionId: outcome.replacement.id,
        correctionNumber: outcome.replacement.documentNumber,
        voidStatus: outcome.result.status,
        requestId: outcome.result.runId,
      },
      { status: outcome.result.status === 'pending_approval' ? 202 : 201 },
    )
  } catch (error) {
    if (error instanceof DocumentEditError || error instanceof DocumentVoidError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}
