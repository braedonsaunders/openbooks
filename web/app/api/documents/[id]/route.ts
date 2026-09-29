import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { isDocumentRevisionToken } from "@/lib/api/registry-data";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/ledger/document-delete.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { checkFlowLock, userRoleKeys } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz, can, guardSubsidiaryScope, subsidiariesInScope } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { isUuid } from '../../../../lib/list-params'
import { applyDocumentEdit, isDocKindEnabled } from "../../../../lib/documents.ts";
import { DOCUMENT_EDIT_VERSION_REQUIRED, DocumentEditError } from "../../../../../engine/src/records/document-edit-policy.ts";
import { documentRevisionCounterSql } from "../../../../../engine/src/records/revision.ts";
import { loadDocument } from "../../../../../engine/src/ledger/document-service.ts";
import { DOC_KINDS, createPermission } from "../../../../lib/document-kinds.ts";
import { canReadDocumentKind } from "../../../../lib/flow-subject-authz.ts";
import { lockedDocumentScopeDenied } from "../../../../lib/document-scope.ts";
import { type DocumentEditCurrent, type DocumentEditInput } from "../../../../../engine/src/ledger/document-input.ts";
import { notFound } from "@/lib/api/responses";
const jsonObjectSchema = z.record(z.string(), z.json());
const documentLineSchema = z.object({
  // An intentionally blank account reaches document-edit's line-numbered
  // refusal, which names the missing posting prerequisite for the operator.
  lineId: z.string().uuid().nullable().optional(), accountId: z.union([z.string().uuid(), z.literal('')]),
  amount: z.string(), description: z.string().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(), taxGroupId: z.string().uuid().nullable().optional(),
  taxOverridden: z.boolean().optional(), taxAmount: z.string().nullable().optional(),
  itemId: z.string().uuid().nullable().optional(), quantity: z.string().nullable().optional(),
  unit: z.string().nullable().optional(), unitPrice: z.string().nullable().optional(),
  partyId: z.string().uuid().nullable().optional(), departmentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(), locationId: z.string().uuid().nullable().optional(),
  classId: z.string().uuid().nullable().optional(), stockLocationId: z.string().uuid().nullable().optional(),
  inventoryReturnSource: z.object({ movementId: z.string().uuid(), lotId: z.string().uuid().nullable().optional(), serialId: z.string().uuid().nullable().optional() }).nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(), custom: jsonObjectSchema.optional(),
  distributionKey: z.string().uuid().nullable().optional(), distributionGroupId: z.string().uuid().nullable().optional(),
  distributionLocked: z.boolean().nullable().optional(),
});
const PATCHBodySchema1 = z.object({
  expectedUpdatedAt: z.string().min(1).optional(), lines: z.array(documentLineSchema).optional(),
  subsidiaryId: z.string().uuid().nullable().optional(),
  partyId: z.string().uuid().nullable().optional(), paymentCardId: z.string().uuid().nullable().optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  referenceNumber: z.string().nullable().optional(), memo: z.string().nullable().optional(),
  postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(), projectId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(), classId: z.string().uuid().nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(), expectedPayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  paymentHoldReason: z.string().nullable().optional(), internalNotes: z.string().nullable().optional(),
  billingMethod: z.string().nullable().optional(), isFinalInvoice: z.boolean().optional(), currency: z.string().optional(),
  custom: jsonObjectSchema.optional(), unsplitDistributionGroups: z.array(z.string().uuid()).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." });



export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

export const GET = defineRoute({
  public: 'session',
  handler: async ({ params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const owned = (await db.execute<{ kind: string; subsidiaryId: string | null }>(
        sql`select kind, subsidiary_id as "subsidiaryId" from documents where id = ${id} and org_id = ${authz.user.orgId}`,
      ))
    const row = owned.rows[0]
    if (!row) return notFound("record")
    const denied = guardSubsidiaryScope(authz, row.subsidiaryId)
    if (denied) return denied
    if (!(await isDocKindEnabled(authz.user.orgId, row.kind))) {
        return notFound("record")
      }
    if (!DOC_KINDS[row.kind]) {
        return NextResponse.json({ error: `kind "${row.kind}" is not served here` }, { status: 422 })
      }
    if (!canReadDocumentKind(authz, row.kind)) {
        return notFound("record")
      }
    const doc = await loadDocument(id, authz.user.orgId)
    if (!doc) return notFound("record")
    const redisclosed = guardSubsidiaryScope(authz, doc.doc.subsidiary_id as string | null)
    if (redisclosed) return redisclosed
    return NextResponse.json(doc)
  },
});

/**
 * Save a posting document. Auth + status/lock guards live here; the header +
 * lines write, GL re-materialization, transaction audit, and on_update flows
 * are the shared `applyDocumentEdit` service (also used by the REST API), so
 * the two write paths can never diverge.
 */
export const PATCH = defineRoute({
  public: 'session',
  body: PATCHBodySchema1,
  invalidBodyStatus: 422,
  handler: async ({ params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const user = authz.user
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const owned = (await db.execute<(DocumentEditCurrent & { subsidiaryId: string | null })>(
        sql`select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
                   document_date as "documentDate",
                   custom,
                   ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt",
                   subsidiary_id as "subsidiaryId"
              from documents where id = ${id} and org_id = ${user.orgId}`,
      ))
    const row = owned.rows[0]
    if (!row) return notFound("record")
    const denied = guardSubsidiaryScope(authz, row.subsidiaryId)
    if (denied) return denied
    if (!(await isDocKindEnabled(user.orgId, row.kind))) {
        return notFound("record")
      }
    const cfg = DOC_KINDS[row.kind]
    if (!cfg) return NextResponse.json({ error: `kind "${row.kind}" is not editable here` }, { status: 422 })
    if (!canReadDocumentKind(authz, row.kind)) {
        return notFound("record")
      }
    const editPerm = row.kind === 'project_charge' ? 'projects.manage' : createPermission(row.kind)
    if (!can(authz, editPerm)) {
        return NextResponse.json({ error: `missing permission: ${editPerm}` }, { status: 403 })
      }
    if (row.status !== 'draft') {
        return NextResponse.json(
          { error: `a ${row.status} document cannot be edited — return it to draft or create a controlled correction` },
          { status: 422 },
        )
      }
    {
        const roles = await userRoleKeys(user.orgId, user.id)
        const lock = await checkFlowLock(row.kind, id, {
          isAdmin: user.isSuperAdmin || roles.has('admin'),
          roles: [...roles],
        })
        if (lock) {
          return NextResponse.json(
            { error: `this document is locked by a workflow${lock.reason ? ` — ${lock.reason}` : ''}` },
            { status: 409 },
          )
        }
      }

    const body = (routeBody) as DocumentEditInput
    if (body.subsidiaryId !== undefined && !subsidiariesInScope(authz, [body.subsidiaryId])) {
        return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
      }
    if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
        return NextResponse.json({ error: DOCUMENT_EDIT_VERSION_REQUIRED }, { status: 409 })
      }
    if (Array.isArray(body.lines) && !(await isFeatureEnabled(user.orgId, 'inventory'))) {
        const stored = (await db.execute<{ item_id: string }>(sql`
          select item_id from document_lines
           where org_id = ${user.orgId} and document_id = ${id} and item_id is not null`))
        const storedIds = new Set(stored.rows.map((row) => row.item_id))
        for (const line of body.lines) {
          if (!line.itemId || !isUuid(line.itemId) || storedIds.has(line.itemId)) continue
          const item = (await db.execute<{ kind: string }>(sql`
            select kind from items where id = ${line.itemId} and org_id = ${user.orgId}`))
          if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
            return notFound("record")
          }
        }
      }
    if (Array.isArray(body.lines) && !(await isFeatureEnabled(user.orgId, 'equipment'))) {
        const stored = (await db.execute<{ item_id: string }>(sql`
          select item_id from document_lines
           where org_id = ${user.orgId} and document_id = ${id} and item_id is not null`))
        const storedIds = new Set(stored.rows.map((row) => row.item_id))
        for (const line of body.lines) {
          if (!line.itemId || !isUuid(line.itemId) || storedIds.has(line.itemId)) continue
          const item = (await db.execute<{ kind: string }>(sql`
            select kind from items where id = ${line.itemId} and org_id = ${user.orgId}`))
          if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
            return notFound("record")
          }
        }
      }
    try {
        // The edit and the locked scope recheck commit as one unit: a rehome
        // that landed after the precheck meets the uniform 404 and writes
        // nothing, instead of editing another subsidiary's document.
        await withOrgTransaction(user.orgId, async () => {
          const relocked = await lockedDocumentScopeDenied(authz, id)
          if (relocked) throw new DocumentEditError(404, 'not found')
          await applyDocumentEdit(id, row, body, {
            orgId: user.orgId,
            userId: user.id,
            source: 'ui',
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          })
        })
      } catch (e) {
        if (e instanceof DocumentEditError) {
          return apiErrorResponse(e, { details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : undefined })
        }
        throw e
      }
    const doc = await loadDocument(id, user.orgId)
    return NextResponse.json(doc)
  },
});

/** Delete a document (guarded: open period, no applied payments, no downstream conversion). */
export const DELETE = defineRoute({
  public: 'session',
  handler: async ({ request: req, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const owned = (await db.execute<{ kind: string; subsidiaryId: string | null }>(
        sql`select kind, subsidiary_id as "subsidiaryId" from documents where id = ${id} and org_id = ${authz.user.orgId}`,
      ))
    const row = owned.rows[0]
    if (!row) return notFound("record")
    const denied = guardSubsidiaryScope(authz, row.subsidiaryId)
    if (denied) return denied
    if (!(await isDocKindEnabled(authz.user.orgId, row.kind))) {
        return notFound("record")
      }
    const cfg = DOC_KINDS[row.kind]
    if (!cfg) return NextResponse.json({ error: `kind "${row.kind}" is not editable here` }, { status: 422 })
    if (!canReadDocumentKind(authz, row.kind)) {
        return notFound("record")
      }
    const editPerm = row.kind === 'project_charge' ? 'projects.manage' : createPermission(row.kind)
    if (!can(authz, editPerm)) {
        return NextResponse.json({ error: `missing permission: ${editPerm}` }, { status: 403 })
      }
    {
        const roles = await userRoleKeys(authz.user.orgId, authz.user.id)
        const lock = await checkFlowLock(row.kind, id, {
          isAdmin: authz.user.isSuperAdmin || roles.has('admin'),
          roles: [...roles],
        })
        if (lock) {
          return NextResponse.json(
            { error: `this document is locked by a workflow${lock.reason ? ` — ${lock.reason}` : ''}` },
            { status: 409 },
          )
        }
      }
    try {
        const routeBodySchema2 = z.object({ reason: z.string().optional(), expectedUpdatedAt: z.string().min(1) });
    const parsedBody2 = await parseJsonBody(req, routeBodySchema2);
        if (!parsedBody2.ok) return parsedBody2.response;
        const body = (parsedBody2.data) as { reason?: string; expectedUpdatedAt?: string }
        if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
          return NextResponse.json({ error: DOCUMENT_EDIT_VERSION_REQUIRED }, { status: 409 })
        }
        // The delete and the locked scope recheck commit as one unit: a rehome
        // that landed after the precheck meets the uniform 404 and deletes
        // nothing, instead of deleting another subsidiary's document.
        const denied = await withOrgTransaction(authz.user.orgId, async () => {
          const relocked = await lockedDocumentScopeDenied(authz, id)
          if (relocked) return relocked
          await deleteDocument(id, authz.user.id, authz.user.orgId, {
            source: 'ui',
            reason: body.reason,
            expectedUpdatedAt: body.expectedUpdatedAt,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          })
          return null
        })
        if (denied) return denied
        return NextResponse.json({ ok: true })
      } catch (e) {
        if (e instanceof ScopeNotFoundError) return notFound("record")
        if (e instanceof DeleteError) return apiErrorResponse(e)
        throw e
      }
  },
});
