import { documentCorrectionBodySchema } from '@/lib/api/document-edit-schema';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { DocumentVoidError, DocumentEditError, type DocumentEditInput } from '@openbooks/engine/documents'
import { can, getAuthz, guardSubsidiaryScope, subsidiariesInScope } from '../../../../../lib/authz'
import { createPermission, DOC_KINDS, postPermission } from "../../../../../lib/document-kinds.ts";
import { canReadDocumentKind } from "../../../../../lib/flow-subject-authz.ts";
import { correctPostedDocumentWithEditor, runPostedCorrectionDraftFlows, isDocKindEnabled } from "../../../../../lib/documents.ts";
import { isUuid } from '../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";
export const runtime = 'nodejs'

export const POST = defineRoute({
  public: 'session',
  body: documentCorrectionBodySchema,
  handler: async ({ request: _req, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const found = (await db.execute<{ kind: string; status: string; subsidiaryId: string | null }>(sql`
        select kind, status, subsidiary_id as "subsidiaryId"
          from documents
         where id = ${id} and org_id = ${authz.user.orgId}
      `))
    const source = found.rows[0]
    if (!source) return notFound("record")
    const denied = guardSubsidiaryScope(authz, source.subsidiaryId)
    if (denied) return denied
    if (!(await isDocKindEnabled(authz.user.orgId, source.kind))) {
        return notFound("record")
      }
    if (!DOC_KINDS[source.kind]) {
        return NextResponse.json(
          { error: 'this transaction type uses its dedicated correction workflow' },
          { status: 422 },
        )
      }
    if (!canReadDocumentKind(authz, source.kind)) {
        return notFound("record")
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

    const body = (routeBody) as DocumentEditInput
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
          const { replacement, voidResult: result } = await correctPostedDocumentWithEditor(id, body, {
            orgId: authz.user.orgId, userId: authz.user.id, source: 'posted_correction',
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
          return apiErrorResponse(error)
        }
        throw error
      }
  },
});
