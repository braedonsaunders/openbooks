import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/index.ts'
import { can, getAuthz, guardSubsidiaryScope, subsidiariesInScope } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { isFeatureEnabled } from '../../../lib/features'
import { DocumentCreateConflict, createDocument, isDocKindEnabled } from "../../../lib/documents.ts";
import { DocumentEditError } from "../../../../engine/src/records/document-edit-policy.ts";
import { loadDocument } from "../../../../engine/src/ledger/document-service.ts";
import { createPermission, isDocumentCreateKind } from "../../../lib/document-kinds.ts";
import type { DocumentEditInput } from "../../../../engine/src/ledger/document-input.ts";
import { notFound } from "@/lib/api/responses";
const jsonObjectSchema = z.record(z.string(), z.json());
const documentLineSchema = z.object({
  lineId: z.string().uuid().nullable().optional(), accountId: z.string().uuid(),
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
const POSTBodySchema1 = z.object({
  kind: z.enum(['customer_invoice', 'customer_credit', 'cash_sale', 'cash_refund', 'vendor_bill', 'vendor_credit', 'card_charge', 'card_refund', 'check', 'deposit', 'transfer'], { error: 'unknown document kind' }),
  expectedUpdatedAt: z.string().optional(),
  partyId: z.string().uuid().nullable().optional(), paymentCardId: z.string().uuid().nullable().optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  referenceNumber: z.string().nullable().optional(), memo: z.string().nullable().optional(),
  postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(), projectId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(), classId: z.string().uuid().nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(), subsidiaryId: z.string().uuid().nullable().optional(),
  expectedPayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  paymentHoldReason: z.string().nullable().optional(), internalNotes: z.string().nullable().optional(),
  billingMethod: z.string().nullable().optional(), isFinalInvoice: z.boolean().optional(), currency: z.string().optional(),
  custom: jsonObjectSchema.optional(), lines: z.array(documentLineSchema).optional(),
  unsplitDistributionGroups: z.array(z.string().uuid()).optional(),
});



export const runtime = 'nodejs'

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

/**
 * Explicit create for the shared DOCUMENT transaction kinds (customer
 * invoice/credit, vendor bill/credit, card charge/refund, check, deposit,
 * transfer).
 *
 * The unsaved-create contract (exemplar: POST /api/accounts): clicking New
 * is URL-only (`?doc=new&kind=`) and opens the tenant-customizable
 * DocumentDrawer in createMode over an in-memory payload — no document, no
 * number, no lines, no audit row exist before this endpoint runs on explicit
 * Save. Cancel/close navigates away and writes nothing.
 *
 * The caller supplies a UUID idempotency key, which becomes the document
 * id: retrying the same request returns the same document without a
 * duplicate insert or audit event, while reusing the key for a changed
 * request — or against another org's row — is a 409 conflict. The number
 * allocates here on Save, never on New.
 *
 * Atomicity: the claim, the number, the insert audit, and the full
 * validated header/lines write commit in ONE transaction inside the shared
 * createDocument service (validation is the applyDocumentEdit core PATCH
 * uses, so create refuses exactly what an edit refuses with the same
 * messages). An invalid Save leaves zero document, zero audit insert, zero
 * flow side effects, and no idempotency claim. Creation always yields
 * status=draft; submit/post stay on the existing actions route, so the
 * draft lifecycle after save is unchanged.
 */
export const POST = defineRoute({
  public: 'session',
  body: POSTBodySchema1,
  handler: async ({ request: req , body: routeBody }) => {
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const user = authz.user
    const requestId = req.headers.get('Idempotency-Key')?.trim() ?? ''
    if (!isUuid(requestId)) {
        return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
      }

    const { kind: rawKind, ...rest } = routeBody as { kind?: unknown } & Record<string, unknown>
    if (typeof rawKind !== 'string' || !isDocumentCreateKind(rawKind)) {
        return NextResponse.json({ error: 'unknown document kind' }, { status: 400 })
      }
    const kind = rawKind
    const { expectedUpdatedAt: _dropped, ...editFields } = rest as DocumentEditInput & { expectedUpdatedAt?: unknown }
    void _dropped
    const body = editFields as DocumentEditInput
    const editPerm = createPermission(kind)
    if (!can(authz, editPerm)) {
        return NextResponse.json({ error: `missing permission: ${editPerm}` }, { status: 403 })
      }
    if (!(await isDocKindEnabled(user.orgId, kind))) {
        return notFound("record")
      }
    if (body.subsidiaryId !== undefined && !subsidiariesInScope(authz, [body.subsidiaryId])) {
        return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
      }
    if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
        const known = isUuid(body.subsidiaryId)
          && (await db.execute<{ id: string }>(sql`
            select id from subsidiaries
             where id = ${body.subsidiaryId} and org_id = ${user.orgId}`)).rows.length > 0
        if (!known) {
          return NextResponse.json({ error: 'invalid subsidiary' }, { status: 422 })
        }
      }
    if (body.documentDate !== undefined && body.documentDate !== null) {
        const raw = body.documentDate
        const wellFormed = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
        // Date.toISOString() THROWS on an Invalid Date, so validity is checked
        // before the round-trip rather than through it.
        const parsed = wellFormed ? new Date(`${raw}T00:00:00Z`) : null
        const real =
          parsed !== null
          && !Number.isNaN(parsed.getTime())
          && parsed.toISOString().slice(0, 10) === raw
        if (!real) {
          return NextResponse.json({ error: 'invalid documentDate' }, { status: 422 })
        }
      }
    if (Array.isArray(body.lines) && !(await isFeatureEnabled(user.orgId, 'inventory'))) {
        for (const line of body.lines) {
          if (!line.itemId || !isUuid(line.itemId)) continue
          const item = (await db.execute<{ kind: string }>(sql`
            select kind from items where id = ${line.itemId} and org_id = ${user.orgId}`))
          if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
            return notFound("record")
          }
        }
      }
    if (Array.isArray(body.lines) && !(await isFeatureEnabled(user.orgId, 'equipment'))) {
        for (const line of body.lines) {
          if (!line.itemId || !isUuid(line.itemId)) continue
          const item = (await db.execute<{ kind: string }>(sql`
            select kind from items where id = ${line.itemId} and org_id = ${user.orgId}`))
          if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
            return notFound("record")
          }
        }
      }
    let subsidiaryId: string | null = null
    if (body.subsidiaryId !== undefined) {
        subsidiaryId = body.subsidiaryId
      } else {
        const roots = (await db.execute<{ id: string }>(sql`
          select id from subsidiaries
           where org_id = ${user.orgId} and is_active and not is_elimination
           order by (parent_id is null) desc, name`)).rows.map((r) => r.id)
        subsidiaryId = roots.find((id) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(id)) ?? null
        if (!subsidiaryId) {
          return NextResponse.json({ error: 'no_available_subsidiary' }, { status: 409 })
        }
      }
    let created: Awaited<ReturnType<typeof createDocument>>
    try {
        created = await createDocument({
          orgId: user.orgId,
          userId: user.id,
          kind,
          key: requestId,
          body,
          subsidiaryId,
          requestBody: routeBody,
        })
      } catch (e) {
        if (e instanceof DocumentCreateConflict) {
          // Fail closed: a reused key with a changed payload, or a key
          // colliding with another org's row, never returns the older row as
          // though it matched.
          return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
        }
        if (e instanceof DocumentEditError) {
          if (e.status === 404 && e.message === 'not found') return notFound("record")
          return apiErrorResponse(e, { details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : undefined })
        }
        throw e
      }
    if (created.status === 'replayed') {
        const doc = await loadDocument(created.id, user.orgId)
        if (!doc) return notFound("record")
        const replayDenied = guardSubsidiaryScope(
          authz,
          doc.doc.subsidiary_id as string | null,
        )
        if (replayDenied) return replayDenied
        return NextResponse.json(doc)
      }
    await runRecordFlows({ kind: 'on_create', source: 'ui' }, kind, created.id, { orgId: user.orgId, userId: user.id })
    if (created.deferredUpdate) {
        await runRecordFlows(created.deferredUpdate, kind, created.id, { orgId: user.orgId, userId: user.id })
      }
    const doc = await loadDocument(created.id, user.orgId)
    if (!doc) return notFound("record")
    const createdDenied = guardSubsidiaryScope(
        authz,
        doc.doc.subsidiary_id as string | null,
      )
    if (createdDenied) return createdDenied
    return NextResponse.json(doc, { status: 201 })
  },
});
