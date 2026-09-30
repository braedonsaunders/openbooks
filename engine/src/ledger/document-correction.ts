/** Controlled posted-document correction command. Adapters provide draft editing,
 * while the engine owns source locking, revision/scope checks and retained evidence. */
import { sql } from 'drizzle-orm'
import { db, schema, withOrgTransaction } from '../platform/db.ts'
import { actorHasPermission } from '../organization/actor-permissions.ts'
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { DOC_KIND_FEATURE } from '../records/document-kind-features.ts'
import { documentKindPermissions } from '../records/document-kind-permissions.ts'
import { actorAllowedSubsidiaryIds } from '../organization/actor-subsidiaries.ts'
import { subsidiaryScopeAllows } from '../organization/subsidiary-scope.ts'
import { documentRevisionCounterSql } from '../records/revision.ts'
import {
  DocumentEditError, requireDocumentEditRevision, validateCorrectionReason,
  runDocumentVersionedTransaction, assertNoExistingDocumentCorrection, buildReversalLinkEvidence,
} from '../records/document-edit-policy.ts'
import { requestDocumentVoid } from './document-void.ts'
import { loadDocumentEditCurrent } from './document-service.ts'
import type { DocumentEditInput, DocumentEditCurrent } from './document-input.ts'

type DocumentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export interface CorrectionContext {
  orgId: string
  userId: string
  source: 'ui' | 'api' | 'mcp' | 'assistant' | 'posted_correction'
  runFlows?: boolean
}
/** Transitional editor port: callbacks participate in the ambient organization
 * transaction. No callback may commit, dispatch flows or perform external work. */
export interface CorrectionDraftWriter {
  createDraft(kind: string, options: {
    allowedSubsidiaryIds: ReadonlySet<string> | null
    subsidiaryId: string | null
    runFlows: false
    source: CorrectionContext['source']
  }): Promise<{ id: string; documentNumber: string }>
  applyEdit(id: string, current: DocumentEditCurrent, input: DocumentEditInput,
    context: CorrectionContext): Promise<unknown>
}

export async function createPostedCorrection(
  sourceId: string,
  body: DocumentEditInput,
  ctx: CorrectionContext,
  writer: CorrectionDraftWriter,
): Promise<{ id: string; documentNumber: string; kind: string }> {
  const expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  const reason = validateCorrectionReason(body.amendmentReason)

  return await withOrgTransaction(ctx.orgId, async () => runDocumentVersionedTransaction<
    DocumentTransaction,
    { kind: string; status: string; subsidiaryId: string | null; updatedAt: string },
    { id: string; documentNumber: string; kind: string }
  >({
    expectedRevision,
    transaction: (work) => db.transaction(work),
    // The source revision is authoritative only while this lock is held. The
    // caller's outer command transaction (when present) is reused, so the lock
    // spans every dependent replacement write.
    lock: async (tx) => {
      await acquireOrgFeatureGateLock(tx, ctx.orgId)
      return (await tx.execute<{
      kind: string
      status: string
      subsidiaryId: string | null
      updatedAt: string
    }>(sql`
      select kind, status, subsidiary_id as "subsidiaryId",
             ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
       from documents
       where id = ${sourceId} and org_id = ${ctx.orgId}
       for update
    `)).rows[0] ?? null
    },
    mutate: async (tx, source) => {
      const allowed = await actorAllowedSubsidiaryIds(tx, ctx.orgId, ctx.userId)
      if (!subsidiaryScopeAllows(allowed, source.subsidiaryId)) {
        throw new DocumentEditError(404, 'not found')
      }
      const permissions = documentKindPermissions(source.kind)
      if (!permissions) {
        throw new DocumentEditError(422, 'this transaction type requires its dedicated correction workflow')
      }
      for (const permission of new Set([permissions.edit, permissions.approve])) {
        if (!await actorHasPermission(tx, ctx.orgId, ctx.userId, permission)) {
          throw new DocumentEditError(403, `missing permission: ${permission}`)
        }
      }
      const feature = DOC_KIND_FEATURE[source.kind]
      if (feature && !await lockAndCheckOrgFeature(tx, ctx.orgId, feature)) {
        throw new DocumentEditError(422, 'enable the transaction feature in Company Settings → Features before creating a correction')
      }
      const existingCorrection = (await tx.execute<{ documentNumber: string }>(sql`
        select replacement.document_number as "documentNumber"
          from document_links link
          join documents replacement
            on replacement.id = link.from_document_id
           and replacement.org_id = link.org_id
         where link.org_id = ${ctx.orgId}
           and link.to_document_id = ${sourceId}
           and link.link_type = 'reverses'
         limit 1
      `)).rows[0]
      assertNoExistingDocumentCorrection(existingCorrection?.documentNumber ?? null)
      if (source.status !== 'posted') {
        throw new DocumentEditError(422, 'only a posted document can create a correcting replacement')
      }
      // The replacement inherits the source's (already scope-gated)
      // subsidiary unless the body re-homes it; the factory validates the
      // result against the actor's real scope, never the org root.
      const replacement = await writer.createDraft(source.kind, {
        allowedSubsidiaryIds: allowed,
        subsidiaryId: body.subsidiaryId ?? source.subsidiaryId,
        runFlows: false,
        source: ctx.source,
      })
      const row = await loadDocumentEditCurrent(replacement.id, ctx.orgId)
      if (!row) throw new Error(`replacement document ${replacement.id} disappeared during initialization`)
      if (row.kind !== source.kind || row.status !== 'draft' || !subsidiaryScopeAllows(allowed, row.subsidiaryId)) {
        throw new DocumentEditError(422, 'the replacement must be a draft of the same transaction type in an authorized subsidiary')
      }
      await writer.applyEdit(
        replacement.id,
        row,
        {
          ...body,
          expectedUpdatedAt: row.updatedAt,
          // The drawer copies the SOURCE document's rows into the correction
          // body, identities included: on the fresh replacement those are
          // foreign, so the copy boundary treats every copied line as new.
          lines: body.lines?.map((line) => {
            if (line.lineId === undefined || line.lineId === null) return line
            const copy = { ...line }
            delete copy.lineId
            return copy
          }),
        },
        {
          ...ctx,
          source: 'posted_correction',
          runFlows: false,
        },
      )
      const edited = await loadDocumentEditCurrent(replacement.id, ctx.orgId)
      if (!edited || edited.kind !== source.kind || edited.status !== 'draft' || !subsidiaryScopeAllows(allowed, edited.subsidiaryId)) {
        throw new DocumentEditError(422, 'the correction editor did not retain an authorized draft; reload and retry the correction')
      }
      const stamped = await tx.execute<{ id: string }>(sql`
        update documents
           set custom = coalesce(custom, '{}'::jsonb) ||
             ${JSON.stringify({
               correctionOf: sourceId,
               correctionReason: reason,
             })}::jsonb,
               updated_at = greatest(
                 clock_timestamp(),
                 updated_at + interval '1 microsecond'
               ),
               updated_by = ${ctx.userId}
         where id = ${replacement.id} and org_id = ${ctx.orgId}
         returning id
      `)
      if (stamped.rows.length !== 1) {
        throw new DocumentEditError(409, 'the replacement could not be saved; reload the source and retry the correction')
      }
      await tx.insert(schema.documentLinks).values({
        orgId: ctx.orgId,
        ...buildReversalLinkEvidence({
          fromDocumentId: replacement.id,
          toDocumentId: sourceId,
          reason,
          requestedBy: ctx.userId,
        }),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${ctx.orgId}, 'documents', ${replacement.id}, 'insert',
          ${JSON.stringify({
            mode: 'posted_correction_draft',
            sourceDocumentId: sourceId,
            reason,
          })}::jsonb,
          ${ctx.userId}, 'posted_correction'
        )
      `)
      return { ...replacement, kind: source.kind }
    },
  }))
  }

/** A refusal to void must roll back the retained draft and its correction link.
 * Adapters retain their native approval-routing and deferred-effect transaction boundaries. */
export async function correctPostedDocument(
  sourceId: string,
  input: DocumentEditInput,
  context: CorrectionContext,
  writer: CorrectionDraftWriter,
) {
  return withOrgTransaction(context.orgId, async () => {
    const replacement = await createPostedCorrection(sourceId, input, context, writer)
    const voidResult = await requestDocumentVoid({
      documentId: sourceId, orgId: context.orgId, actorId: context.userId,
      reason: validateCorrectionReason(input.amendmentReason),
      source: context.source === 'posted_correction' ? 'ui' : context.source,
    })
    return { replacement, voidResult }
  })
}
