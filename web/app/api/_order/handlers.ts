import { documentRevisionCounterSql } from "@openbooks/engine/src/records/revision.ts"
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { deleteDocument, DeleteError } from '@openbooks/engine/src/ledger/document-delete.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { guardFeaturePermission } from '../../../lib/feature-gates'
import { can, guardSubsidiaryScope } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { assignOrderLineWarehouse, convertOrder, ConversionError } from '../../../lib/order-cycle'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../lib/features'
import { assignWarehouseBody, jsonObject, parseJsonBody } from '@/lib/api/json'
import { unexpectedServerError } from '../../../lib/api/unexpected'
import { notFound } from "@/lib/api/responses";
import { applyOrderEdit, OrderEditError, STALE_REVISION, staleRevision, type OrderEditServices, type OrderPatchBody, type OrderHandlerConfig } from '../../../lib/order-draft-edit'
import { computeOrderTotals, exactOrderMoney, loadOrder, orderTaxProfileMap } from './lib'
import { persistLineTaxComponents } from '../../../lib/bills.ts'
import { activeStockLocations, profiledItemIds, resolveLineStockLocation } from '../../../lib/stock-locations'
import { segmentRegistry, validateExtraDims } from '../../../lib/segments'
import { promoteCrmAccount } from '@openbooks/engine/src/crm/crm.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { issueSalesOrder, SalesOrderIssueError } from '@openbooks/engine/src/sales/sales-orders.ts'
import { DocumentVoidError, requestDocumentVoid } from '@openbooks/engine/src/ledger/document-void.ts'
export type { OrderHandlerConfig } from '../../../lib/order-draft-edit'

export const orderEditServices: OrderEditServices = {
  platform: { db, withOrgTransaction, sql, documentRevisionCounterSql },
  authz: { guardSubsidiaryScope },
  order: { computeOrderTotals, exactOrderMoney, loadOrder, orderTaxProfileMap },
  bills: { persistLineTaxComponents },
  stockLocations: { activeStockLocations, profiledItemIds, resolveLineStockLocation },
  segments: { segmentRegistry, validateExtraDims },
  crm: { promoteCrmAccount },
  features: { isFeatureEnabled, subsidiaryFeatureEnabled },
  flows: { submitAndReleaseIfUngated },
  sales: { issueSalesOrder, SalesOrderIssueError },
  documentVoid: { DocumentVoidError, requestDocumentVoid },
}

/**
 * Shared GET / PATCH / convert handlers for the three order-cycle modules.
 * Each module's route just binds its `kind` + read/create permission keys.
 *
 *   quote          → ar.read / ar.create
 *   sales_order    → ar.read / ar.create
 *   purchase_order → ap.read / ap.create
 */

/** GET: full order payload (header + lines + links) scoped to the org. */
export function makeGET(cfg: OrderHandlerConfig) {
  return async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.readPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    return withOrgTransaction(gate.user.orgId, async () => {
      // Draft writers lock this aggregate before replacing its header/lines.
      // Hold its ownership stable from authorization through payload loading;
      // a concurrent rehome must not disclose the new subsidiary's values.
      const owned = (await db.execute<{ subsidiaryId: string | null }>(
        sql`select subsidiary_id as "subsidiaryId" from documents where id = ${id} and kind = ${cfg.kind} and org_id = ${gate.user.orgId} for share`,
      ))
      if (!owned.rows[0]) return notFound("record")
      const denied = guardSubsidiaryScope(gate, owned.rows[0].subsidiaryId)
      if (denied) return denied
      const order = await loadOrder(id, gate.user.orgId, cfg.kind, gate.allowedSubsidiaryIds)
      if (!order) return notFound("record")
      return NextResponse.json(order)
    })
  }
}

/** Shared PATCH boundary for order edits. */
export function makePATCH(cfg: OrderHandlerConfig) {
  return async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.createPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const parsedBody = await parseJsonBody(req, jsonObject)
    if (!parsedBody.ok) return parsedBody.response
    try {
      return await applyOrderEdit({
        orgId: gate.user.orgId,
        userId: gate.user.id,
        user: gate.user,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        permissions: gate.permissions,
        services: orderEditServices,
      }, cfg, id, parsedBody.data as OrderPatchBody)
    } catch (error) {
      if (error instanceof OrderEditError) {
        return NextResponse.json(error.body, { status: error.status })
      }
      throw error
    }
  }
}
/**
 * DELETE: remove a non-posting order (doc/lines/links). deleteDocument throws
 * DeleteError → 422 if the order was converted downstream (has a document_link
 * to a posted doc).
 */
export function makeDELETE(cfg: OrderHandlerConfig) {
  return async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.createPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    // A missing/malformed body just means no revision token was supplied;
    // the fence below answers that with the same reload-and-retry 409 as a
    // stale token, so legacy empty-body deletes fail closed uniformly.
    const parsedBody = await parseJsonBody(req, jsonObject)
    const expectedUpdatedAt = parsedBody.ok
      ? (parsedBody.data as { expectedUpdatedAt?: string }).expectedUpdatedAt
      : undefined
    return withOrgTransaction(user.orgId, async () => {
      // Draft discard is another lifecycle mutation. Own the same aggregate
      // lock used by issue/void before deleteDocument reads draft status, so a
      // delete that waited behind issuance cannot remove the issued order.
      const owned = (await db.execute<{ subsidiaryId: string | null; updated_at: string }>(sql`
        select subsidiary_id as "subsidiaryId", ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at
          from documents
         where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}
         for update
      `))
      if (!owned.rows[0]) return notFound("record")
      const denied = guardSubsidiaryScope(gate, owned.rows[0].subsidiaryId)
      if (denied) return denied
      if (staleRevision(expectedUpdatedAt, owned.rows[0].updated_at)) {
        return NextResponse.json({ error: STALE_REVISION }, { status: 409 })
      }
      await deleteDocument(id, user.id, user.orgId, { allowedSubsidiaryIds: gate.allowedSubsidiaryIds })
      return NextResponse.json({ ok: true })
    }).catch((error: unknown) => {
      if (error instanceof ScopeNotFoundError) {
        return notFound("record")
      }
      if (error instanceof DeleteError) {
        return NextResponse.json({ error: error.message }, { status: 422 })
      }
      throw error
    })
  }
}

/** POST convert: pull the order forward into `targetKind` via convertOrder(). */
export function makeConvertPOST(cfg: OrderHandlerConfig) {
  return async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.createPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const parsedBody = await parseJsonBody(req, jsonObject)
    if (!parsedBody.ok) return parsedBody.response
    const body = parsedBody.data as {
      targetKind?: string
      expectedUpdatedAt?: string
      creditOverrideReason?: string
    }
    if (!body.targetKind) return NextResponse.json({ error: 'targetKind required' }, { status: 400 })

    // Scope check: the source must be this kind, in the caller's org, and
    // inside the caller's subsidiary scope.
    const owns = (await db.execute<{ subsidiaryId: string | null; updated_at: string }>(
      sql`select subsidiary_id as "subsidiaryId", ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at from documents where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}`,
    ))
    const source = owns.rows[0]
    if (!source) return notFound("record")
    const denied = guardSubsidiaryScope(gate, source.subsidiaryId)
    if (denied) return denied
    // Fulfillment and receipt conversions move stock and post value-carrying
    // inventory journals when Inventory is enabled, so they take items.post
    // on top of the order permission — the same authority the inventory
    // movement API demands (INVENTORY_ACTION_PERMISSIONS). Without it an
    // ar.create/ap.create-only caller posts inventory movements through
    // these convert endpoints. Refused by name before anything converts.
    if ((body.targetKind === 'sales_fulfillment' || body.targetKind === 'purchase_receipt')
      && (await isFeatureEnabled(user.orgId, 'inventory'))
      && !can(gate, 'items.post')) {
      return NextResponse.json({ error: 'missing permission: items.post' }, { status: 403 })
    }
    // Fence the conversion on the caller's revision before creating the
    // downstream document from a possibly outdated source view.
    if (staleRevision(body.expectedUpdatedAt, source.updated_at)) {
      return NextResponse.json({ error: STALE_REVISION }, { status: 409 })
    }

    try {
      const res = await convertOrder(user.orgId, user.id, id, body.targetKind, {
        creditOverrideReason: body.creditOverrideReason,
        expectedUpdatedAt: body.expectedUpdatedAt,
      })
      return NextResponse.json(res)
    } catch (e) {
      if (e instanceof ConversionError) {
        return NextResponse.json(
          {
            error: e.message,
            ...(e.code ? { code: e.code } : {}),
            ...(e.details !== undefined ? { details: e.details } : {}),
          },
          { status: e.status },
        )
      }
      if (e instanceof SalesOrderIssueError) {
        return NextResponse.json(
          { error: e.message, code: e.code, credit: e.details },
          { status: e.status },
        )
      }
      return unexpectedServerError('orders/create', e)
    }
  }
}

/**
 * POST assign-warehouse: set one line's warehouse on an approved order
 * (F-coord-004). Approved lines are storage-immutable, so legacy orders
 * approved before line warehouses existed could never gain one and their
 * fulfillment failed closed with no way forward. Only sales and purchase
 * orders are wired: quotes never relieve stock. Setting the warehouse
 * changes no posted amount — it only routes future shipments/receipts.
 */
export function makeAssignWarehousePOST(cfg: OrderHandlerConfig) {
  return async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await guardFeaturePermission(cfg.createPerm, 'orders')
    if (gate instanceof NextResponse) return gate
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    if (cfg.kind !== 'sales_order' && cfg.kind !== 'purchase_order') {
      return NextResponse.json({ error: 'warehouse assignment applies to sales and purchase orders only' }, { status: 422 })
    }
    const parsedBody = await parseJsonBody(req, assignWarehouseBody)
    if (!parsedBody.ok) return parsedBody.response
    const body = parsedBody.data

    // Scope check: the order must be this kind, in the caller's org, and
    // inside the caller's subsidiary scope. The engine re-locks the
    // aggregate and re-checks the revision inside its transaction, so a
    // row that changes after this probe still cannot be assigned stale.
    const owns = (await db.execute<{ subsidiaryId: string | null; updated_at: string }>(
      sql`select subsidiary_id as "subsidiaryId", ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at from documents where id = ${id} and kind = ${cfg.kind} and org_id = ${user.orgId}`,
    ))
    const source = owns.rows[0]
    if (!source) return notFound("record")
    const denied = guardSubsidiaryScope(gate, source.subsidiaryId)
    if (denied) return denied
    if (staleRevision(body.expectedUpdatedAt, source.updated_at)) {
      return NextResponse.json({ error: STALE_REVISION }, { status: 409 })
    }

    try {
      await assignOrderLineWarehouse({
        orgId: user.orgId,
        userId: user.id,
        orderId: id,
        kind: cfg.kind,
        lineId: body.lineId,
        stockLocationId: body.stockLocationId,
        expectedUpdatedAt: body.expectedUpdatedAt ?? '',
      })
      const order = await loadOrder(id, user.orgId, cfg.kind, gate.allowedSubsidiaryIds)
      return NextResponse.json(order)
    } catch (e) {
      if (e instanceof ConversionError) {
        return NextResponse.json(
          {
            error: e.message,
            ...(e.code ? { code: e.code } : {}),
            ...(e.details !== undefined ? { details: e.details } : {}),
          },
          { status: e.status },
        )
      }
      return unexpectedServerError('orders/assign-warehouse', e)
    }
  }
}
