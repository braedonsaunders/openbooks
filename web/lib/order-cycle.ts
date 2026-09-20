import { documentRevisionCounterSql, isDocumentRevisionToken } from "@openbooks/engine/src/records/revision.ts"
import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { nextDocumentNumber, persistLineTaxComponents } from "./bills.ts";
import {
  ORDER_KINDS,
  PURCHASE_RECEIPT_KIND,
  SALES_FULFILLMENT_KIND,
  type OrderKind,
  CONVERSION_TARGETS,
} from './order-kinds'
import { promoteCrmAccount } from '@openbooks/engine/src/crm/crm.ts'
import { add, mulRatio, neg, sum } from '@openbooks/engine/src/money/money.ts'
import { lineRequiresReceipt } from '@openbooks/engine/src/payables/ap-capture-service.ts'
import {
  billableRemainderQuantityUnits,
  fromQuantityUnits,
  orderLineAmount,
  remainingOrderLine,
  toQuantityUnits,
} from './order-cycle-math'
import { isFeatureEnabled } from './features'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { applyPurchaseReceiptInventory } from "@openbooks/engine/src/inventory/documents-purchasing.ts";
import { applySalesFulfillmentInventoryIssues } from "@openbooks/engine/src/inventory/documents-sales.ts";
import { assertStockLocationAdmitsSubsidiary } from "@openbooks/engine/src/inventory/profile-policy.ts";
import { InventoryError, InventoryOwnershipError } from "@openbooks/engine/src/inventory/contracts.ts";
import { loadSubsidiaryContext } from '@openbooks/engine/src/organization/subsidiaries.ts'
import { issueSalesOrder } from '@openbooks/engine/src/sales/sales-orders.ts'
import { activeStockLocations, resolveLineStockLocation } from './stock-locations'
import { isUuid } from './list-params'

export { ORDER_KINDS, CONVERSION_TARGETS }
export type { OrderKind }

interface OrderSourceRow extends Record<string, unknown> {
  id: string
  kind: string
  status: string
  party_id: string | null
  currency: string
  fx_rate: string
  document_date: string
  due_date: string | null
  subsidiary_id: string | null
  department_id: string | null
  project_id: string | null
  location_id: string | null
  class_id: string | null
  extra_dims: unknown
  memo: string | null
  billing_method: string | null
}

interface OrderConvertLineRow extends Record<string, unknown> {
  id: string
  line_number: number
  item_id: string | null
  account_id: string | null
  description: string | null
  quantity: string
  unit: string | null
  unit_price: string
  amount: string
  tax_code_id: string | null
  tax_group_id: string | null
  tax_amount: string
  department_id: string | null
  project_id: string | null
  location_id: string | null
  class_id: string | null
  extra_dims: unknown
  stock_location_id: string | null
  is_billable: boolean
  quantity_billed: string
  quantity_fulfilled: string
  item_kind: string | null
  item_income_account_id: string | null
}

/**
 * Order-cycle documents (quote / sales_order / purchase_order) are NON-posting
 * commitment documents: they live in `documents` with lines, but never hit the
 * GL. They "pull forward" into a posting document (customer_invoice / vendor_bill)
 * or a downstream order (quote → sales_order) via `convertOrder`, which copies
 * the un-billed remainder of each line, records a `document_links` edge, and
 * advances `quantity_billed` on the source so partial conversions are safe and
 * idempotent-at-the-line-level.
 *
 * Status model (reuses the existing documents.status enum, no schema change):
 *   draft     — being built
 *   approved  — issued / open (the order is live; convertible)
 *   voided    — cancelled
 * "Converted" is derived: an order is fully converted when every line's
 * quantity_billed >= quantity.
 */

const NUMBER_PREFIX: Record<OrderKind, { kind: OrderKind; prefix: string }> = {
  quote: { kind: 'quote', prefix: 'EST-' },
  sales_order: { kind: 'sales_order', prefix: 'SO-' },
  purchase_order: { kind: 'purchase_order', prefix: 'PO-' },
}

/** Create an empty draft order document and return its id + number. */
export async function createOrderDraft(orgId: string, userId: string, kind: OrderKind) {
  if (!(await isFeatureEnabled(orgId, 'orders'))) throw new Error('Orders feature is disabled')
  const cfg = NUMBER_PREFIX[kind]
  const org = (await db.execute<{ base_currency: string }>(
    sql`select base_currency from orgs where id = ${orgId}`,
  ))
  const documentNumber = await nextDocumentNumber(orgId, cfg.kind, cfg.prefix)
  const today = await businessToday(orgId)
  const row = (await db.execute<{ id: string; document_number: string }>(sql`
    insert into documents (org_id, kind, document_number, document_date, currency, subtotal, tax_total, total, created_by)
    values (${orgId}, ${kind}, ${documentNumber}, ${today},
            ${org.rows[0]?.base_currency ?? 'CAD'}, '0', '0', '0', ${userId})
    returning id, document_number
  `))
  return row.rows[0]!
}

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}

/** Machine-readable code for a goods receipt refused over a missing RNB account. */
export const ITEM_MISSING_RNB_ACCOUNT = 'ITEM_MISSING_RNB_ACCOUNT'

/**
 * Machine-readable code for a fulfillment/receipt refused because a stocked
 * order line has no warehouse and the org has no single default to fall
 * back to (F-coord-004). Details carry the offending lineNumber and the
 * active warehouse count the message was built from.
 */
export const ORDER_LINE_WAREHOUSE_REQUIRED = 'ORDER_LINE_WAREHOUSE_REQUIRED'

export interface UnwarehousedOrderLine {
  lineNumber: number
  itemId: string | null
}

/**
 * Selected order lines that cannot ship or receive: stocked (profiled)
 * lines with no warehouse when the warehouse choice is ambiguous. With
 * exactly one active warehouse the posting reader falls back silently, so
 * there is nothing to refuse. Pure so the rule is unit-testable; the
 * fulfillment/receipt writers throw the refusal.
 */
export function missingOrderLineWarehouses(
  lines: { lineNumber: number; itemId: string | null; hasInventoryProfile: boolean; stockLocationId: string | null }[],
  activeWarehouseCount: number,
): UnwarehousedOrderLine[] {
  if (activeWarehouseCount === 1) return []
  return lines
    .filter((line) => line.hasInventoryProfile && !line.stockLocationId)
    .map((line) => ({ lineNumber: line.lineNumber, itemId: line.itemId }))
}

const INVENTORY_ITEM_KINDS = new Set(['inventory', 'assembly', 'kit'])

/** True when converting `sourceId` would copy an inventory / assembly / kit line. */
export async function conversionWouldCopyInventoryKinds(orgId: string, sourceId: string): Promise<boolean> {
  if (await isFeatureEnabled(orgId, 'inventory')) return false
  const lines = (await db.execute<{
    item_id: string | null
    kind: string | null
    quantity: string
    quantity_billed: string
    unit_price: string
    tax_amount: string
  }>(sql`
    select line.item_id, i.kind, line.quantity, line.quantity_billed, line.unit_price, line.tax_amount
      from document_lines line
      left join items i on i.id = line.item_id and i.org_id = line.org_id
     where line.org_id = ${orgId} and line.document_id = ${sourceId}`))
  return lines.rows.some((line) => {
    if (!line.item_id || !line.kind || !INVENTORY_ITEM_KINDS.has(line.kind)) return false
    return remainingOrderLine({
      quantity: String(line.quantity),
      quantityBilled: String(line.quantity_billed),
      unitPrice: String(line.unit_price),
      taxAmount: String(line.tax_amount),
    }) !== null
  })
}

interface ConvertResult {
  id: string
  documentNumber: string
  kind: string
  replayed?: boolean
}

export interface SalesFulfillmentLineInput {
  sourceLineId: string
  quantity: string
  lotId?: string | null
  serialId?: string | null
}

export interface SalesFulfillmentInput {
  fulfillmentDate: string
  /** Required stable command identity. A lost response can be retried with the
   * same key; the stored fulfillment is returned instead of shipping twice. */
  idempotencyKey: string
  lines: SalesFulfillmentLineInput[]
}

interface CanonicalFulfillmentLine {
  sourceLineId: string
  quantity: string
  lotId: string | null
  serialId: string | null
}

interface SalesFulfillmentSourceRow extends Record<string, unknown> {
  id: string
  kind: string
  status: string
  party_id: string | null
  currency: string
  fx_rate: string
  document_date: string
  due_date: string | null
  subsidiary_id: string | null
  department_id: string | null
  project_id: string | null
  location_id: string | null
  class_id: string | null
  extra_dims: Record<string, unknown> | null
  memo: string | null
  billing_method: string | null
}

interface SalesFulfillmentSourceLineRow extends Record<string, unknown> {
  id: string
  line_number: number
  item_id: string | null
  account_id: string | null
  description: string | null
  quantity: string
  unit: string | null
  department_id: string | null
  project_id: string | null
  location_id: string | null
  class_id: string | null
  extra_dims: Record<string, unknown> | null
  stock_location_id: string | null
  quantity_fulfilled: string
  custom: Record<string, unknown> | null
  item_kind: string | null
  has_inventory_profile: boolean
}

function canonicalFulfillmentLines(lines: SalesFulfillmentLineInput[]): CanonicalFulfillmentLine[] {
  if (lines.length === 0) throw new ConversionError('Select at least one line to fulfill')
  const seen = new Set<string>()
  const canonical = lines.map((line) => {
    const sourceLineId = line.sourceLineId.trim()
    if (!sourceLineId) throw new ConversionError('Fulfillment line id is required')
    if (seen.has(sourceLineId)) throw new ConversionError(`Fulfillment line ${sourceLineId} was selected more than once`)
    seen.add(sourceLineId)
    let quantity: string
    try {
      const units = toQuantityUnits(line.quantity)
      if (units <= 0n) throw new Error('non-positive')
      quantity = fromQuantityUnits(units)
    } catch {
      throw new ConversionError(`Fulfillment quantity for line ${sourceLineId} must be positive`)
    }
    return {
      sourceLineId,
      quantity,
      lotId: line.lotId?.trim() || null,
      serialId: line.serialId?.trim() || null,
    }
  })
  return canonical.sort((a, b) => a.sourceLineId.localeCompare(b.sourceLineId))
}

/**
 * Record one immutable sales shipment and relieve inventory/COGS in the same
 * transaction. Source order and line locks fence concurrent partial shipments;
 * a stable command key makes serial and concurrent retries exactly-once.
 */
export async function fulfillSalesOrder(
  orgId: string,
  userId: string,
  sourceId: string,
  input: SalesFulfillmentInput,
): Promise<ConvertResult> {
  if (!(await isFeatureEnabled(orgId, 'orders'))) throw new ConversionError('Orders feature is disabled')
  const idempotencyKey = input.idempotencyKey.trim()
  if (idempotencyKey.length < 1 || idempotencyKey.length > 500) {
    throw new ConversionError('Fulfillment idempotency key must be between 1 and 500 characters')
  }
  if (!isIsoCalendarDate(input.fulfillmentDate)) throw new ConversionError('Fulfillment date must be YYYY-MM-DD')
  const requested = canonicalFulfillmentLines(input.lines)
  const command = {
    fulfillmentDate: input.fulfillmentDate,
    lines: requested,
  }
  return db.transaction(async (tx) => {
    const sourceResult = (await tx.execute<SalesFulfillmentSourceRow>(sql`
      select id, kind, status, party_id, currency, fx_rate, document_date, due_date,
             subsidiary_id, department_id, project_id, location_id, class_id,
             extra_dims, memo, billing_method
        from documents
       where id = ${sourceId} and org_id = ${orgId}
       for update
    `))
    const source = sourceResult.rows[0]
    if (!source) throw new ConversionError('Sales order not found')
    if (source.kind !== 'sales_order') throw new ConversionError('Only a sales order can be fulfilled')
    if (source.status === 'draft') throw new ConversionError('Issue the sales order before fulfilling it')
    if (source.status === 'voided') throw new ConversionError('This sales order is voided')
    if (source.status !== 'approved') throw new ConversionError(`This sales order is ${source.status}`)

    // The source header lock serializes every fulfillment command for this SO.
    // That makes the JSON key unique at the owning aggregate boundary without
    // a second global command table, and lets a retry compare its exact payload.
    const replay = (await tx.execute<{
      id: string
      document_number: string
      command_matches: boolean
    }>(sql`
      select target.id, target.document_number,
             target.custom->'salesFulfillmentCommand' = ${JSON.stringify(command)}::jsonb as command_matches
        from document_links link
        join documents target
          on target.id = link.to_document_id and target.org_id = link.org_id
       where link.org_id = ${orgId} and link.from_document_id = ${sourceId}
         and link.link_type = 'fulfills' and target.kind = ${SALES_FULFILLMENT_KIND}
         and target.custom->>'fulfillmentIdempotencyKey' = ${idempotencyKey}
       limit 1
    `)).rows[0]
    if (replay) {
      if (!replay.command_matches) {
        throw new ConversionError('Fulfillment idempotency key was already used with a different shipment', 409)
      }
      return {
        id: replay.id,
        documentNumber: replay.document_number,
        kind: SALES_FULFILLMENT_KIND,
        replayed: true,
      }
    }

    const sourceLines = (await tx.execute<SalesFulfillmentSourceLineRow>(sql`
      select dl.id, dl.line_number, dl.item_id, dl.account_id, dl.description,
             dl.quantity, dl.unit, dl.department_id, dl.project_id, dl.location_id,
             dl.class_id, dl.extra_dims, dl.stock_location_id, dl.quantity_fulfilled,
             dl.custom, i.kind as item_kind,
             profile.item_id is not null as has_inventory_profile
        from document_lines dl
        left join items i on i.id = dl.item_id and i.org_id = dl.org_id
        left join item_inventory_profiles profile
          on profile.item_id = dl.item_id and profile.org_id = dl.org_id
       where dl.document_id = ${sourceId} and dl.org_id = ${orgId}
       order by dl.line_number
       for update of dl
    `)).rows
    const sourceById = new Map(sourceLines.map((line) => [line.id, line]))
    const selected = requested.map((request) => {
      const line = sourceById.get(request.sourceLineId)
      if (!line) throw new ConversionError(`Sales-order line ${request.sourceLineId} was not found`)
      const remaining = toQuantityUnits(String(line.quantity)) - toQuantityUnits(String(line.quantity_fulfilled))
      const shipping = toQuantityUnits(request.quantity)
      if (remaining <= 0n) throw new ConversionError(`Sales-order line ${line.line_number} is already fully fulfilled`)
      if (shipping > remaining) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} has only ${fromQuantityUnits(remaining)} remaining to fulfill`,
        )
      }
      return { request, line }
    })

    if (!(await isFeatureEnabled(orgId, 'inventory'))) {
      const inventoryLine = selected.find(({ line }) =>
        line.item_id != null && INVENTORY_ITEM_KINDS.has(String(line.item_kind)),
      )
      if (inventoryLine) throw new ConversionError('Inventory is disabled')
    }
    const uncostedInventoryLine = selected.find(({ line }) =>
      line.item_id != null &&
      INVENTORY_ITEM_KINDS.has(String(line.item_kind)) &&
      !line.has_inventory_profile,
    )
    if (uncostedInventoryLine) {
      throw new ConversionError(
        `Sales-order line ${uncostedInventoryLine.line.line_number} is an inventory item without a costing profile`,
      )
    }

    // Orders approved before line warehouses existed carry NULL warehouses
    // and are storage-immutable, so fulfillment would otherwise fail deep
    // inside the inventory kernel with a generic stock-location error.
    // Refuse up front naming the line and the way forward (F-coord-004).
    const activeWarehouses = await activeStockLocations(orgId)
    const unwarehoused = missingOrderLineWarehouses(
      selected.map(({ line }) => ({
        lineNumber: line.line_number,
        itemId: line.item_id,
        hasInventoryProfile: line.has_inventory_profile,
        stockLocationId: line.stock_location_id,
      })),
      activeWarehouses.length,
    )
    const warehouseless = unwarehoused[0]
    if (warehouseless) {
      const details = { lineNumber: warehouseless.lineNumber, activeWarehouses: activeWarehouses.length }
      if (activeWarehouses.length === 0) {
        throw new ConversionError(
          `Sales-order line ${warehouseless.lineNumber} is a stocked item with no warehouse, and this organization has no active warehouse — create one, assign it to the line, then fulfill again`,
          422,
          ORDER_LINE_WAREHOUSE_REQUIRED,
          details,
        )
      }
      throw new ConversionError(
        `Sales-order line ${warehouseless.lineNumber} is a stocked item with no warehouse, and this organization has ${activeWarehouses.length} active warehouses, so fulfillment cannot choose one — assign a warehouse to the line, then fulfill again`,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        details,
      )
    }

    const documentNumber = await nextDocumentNumber(orgId, SALES_FULFILLMENT_KIND, 'SHIP-', source.subsidiary_id)
    const fulfillmentId = randomUUID()
    const custom = {
      fulfillmentIdempotencyKey: idempotencyKey,
      salesFulfillmentCommand: command,
    }
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, document_date, currency,
         fx_rate, status, subsidiary_id, department_id, project_id, location_id,
         class_id, extra_dims, billing_method, memo, subtotal, tax_total, total,
         custom, created_by, updated_by)
      values
        (${fulfillmentId}, ${orgId}, ${SALES_FULFILLMENT_KIND}, ${documentNumber},
         ${source.party_id}, ${input.fulfillmentDate}, ${source.currency}, ${source.fx_rate},
         'draft', ${source.subsidiary_id}, ${source.department_id}, ${source.project_id},
         ${source.location_id}, ${source.class_id}, ${JSON.stringify(source.extra_dims ?? {})}::jsonb,
         ${source.billing_method}, ${source.memo}, '0', '0', '0',
         ${JSON.stringify(custom)}::jsonb, ${userId}, ${userId})
    `)

    // Migration 0034 makes approved document lines immutable. Advancing
    // quantity_fulfilled is operational shipment evidence, not an edit to the
    // approved commercial source. The source header is locked for this
    // transaction, so briefly reopen it while the shipment lines advance and
    // restore approved before another caller can observe the transaction.
    const reopenSourceForLineAdvances = source.status === 'approved'
    if (reopenSourceForLineAdvances) {
      const reopened = (await tx.execute<{ id: string }>(sql`
        update documents
           set status = 'draft', updated_by = ${userId}
         where id = ${sourceId} and org_id = ${orgId} and status = 'approved'
        returning id
      `)).rows[0]
      if (!reopened) throw new ConversionError('Sales order changed while it was being fulfilled', 409)
    }

    let lineNumber = 1
    for (const { request, line } of selected) {
      const lineCustom = {
        ...(line.custom ?? {}),
        fulfillment: {
          sourceLineId: line.id,
          lotId: request.lotId,
          serialId: request.serialId,
        },
      }
      await tx.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, account_id, description,
           quantity, unit, unit_price, amount, tax_amount, department_id,
           project_id, location_id, class_id, extra_dims, stock_location_id,
           is_billable, custom, created_by, updated_by)
        values
          (${orgId}, ${fulfillmentId}, ${lineNumber}, ${line.item_id}, ${line.account_id},
           ${line.description}, ${request.quantity}, ${line.unit}, '0', '0', '0',
           ${line.department_id}, ${line.project_id}, ${line.location_id}, ${line.class_id},
           ${JSON.stringify(line.extra_dims ?? {})}::jsonb, ${line.stock_location_id}, false,
           ${JSON.stringify(lineCustom)}::jsonb, ${userId}, ${userId})
      `)
      const advanced = (await tx.execute<{ id: string }>(sql`
        update document_lines
           set quantity_fulfilled = quantity_fulfilled + ${request.quantity},
               updated_by = ${userId}
         where id = ${line.id} and org_id = ${orgId}
           and quantity_fulfilled + ${request.quantity} <= quantity
        returning id
      `)).rows[0]
      if (!advanced) {
        throw new ConversionError(`Sales-order line ${line.line_number} changed while it was being fulfilled`, 409)
      }
      lineNumber++
    }

    if (reopenSourceForLineAdvances) {
      const restored = (await tx.execute<{ id: string }>(sql`
        update documents
           set status = 'approved', updated_by = ${userId}
         where id = ${sourceId} and org_id = ${orgId} and status = 'draft'
        returning id
      `)).rows[0]
      if (!restored) throw new ConversionError('Sales order changed while it was being fulfilled', 409)
    }

    await tx.execute(sql`
      insert into document_links
        (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${sourceId}, ${fulfillmentId}, 'fulfills', ${userId})
    `)
    await applySalesFulfillmentInventoryIssues(
      tx,
      orgId,
      userId,
      fulfillmentId,
      input.fulfillmentDate,
      source.subsidiary_id,
    )
    await tx.execute(sql`
      update documents
         set status = 'approved', updated_by = ${userId}
       where id = ${fulfillmentId} and org_id = ${orgId}
    `)
    return { id: fulfillmentId, documentNumber, kind: SALES_FULFILLMENT_KIND }
  })
}

/** Existing conversion routes carry only a target kind. Fulfill the complete
 * current remainder through that established surface while deriving a stable
 * key from the observed source state: concurrent clicks share a key and replay
 * the winner instead of creating two shipments. Call fulfillSalesOrder
 * directly when a picker supplies explicit partial quantities. */
async function fulfillSalesOrderRemainder(
  orgId: string,
  userId: string,
  sourceId: string,
): Promise<ConvertResult> {
  const fulfillmentDate = await businessToday(orgId)
  const rows = (await db.execute<{
    id: string
    quantity: string
    quantity_fulfilled: string
  }>(sql`
    select line.id, line.quantity, line.quantity_fulfilled
      from document_lines line
      join documents source
        on source.id = line.document_id and source.org_id = line.org_id
     where line.org_id = ${orgId} and source.id = ${sourceId}
       and source.kind = 'sales_order'
     order by line.id
  `)).rows
  const lines = rows.flatMap((line) => {
    const remaining = toQuantityUnits(line.quantity) - toQuantityUnits(line.quantity_fulfilled)
    return remaining > 0n
      ? [{ sourceLineId: line.id, quantity: fromQuantityUnits(remaining) }]
      : []
  })
  if (lines.length === 0) {
    const latest = (await db.execute<{ id: string; document_number: string }>(sql`
      select target.id, target.document_number
        from document_links link
        join documents target
          on target.id = link.to_document_id and target.org_id = link.org_id
       where link.org_id = ${orgId} and link.from_document_id = ${sourceId}
         and link.link_type = 'fulfills' and target.kind = ${SALES_FULFILLMENT_KIND}
       order by target.created_at desc, target.id desc
       limit 1
    `)).rows[0]
    if (!latest) throw new ConversionError('Every line is already fully fulfilled')
    return {
      id: latest.id,
      documentNumber: latest.document_number,
      kind: SALES_FULFILLMENT_KIND,
      replayed: true,
    }
  }
  const idempotencyKey = `sales-fulfillment-remainder:${createHash('sha256')
    .update(JSON.stringify({ sourceId, fulfillmentDate, lines }))
    .digest('hex')}`
  return fulfillSalesOrder(orgId, userId, sourceId, {
    fulfillmentDate,
    idempotencyKey,
    lines,
  })
}

export type PurchaseReceiptLineInput = SalesFulfillmentLineInput

export interface PurchaseReceiptInput {
  receiptDate: string
  /** Required stable command identity: a lost response retried with the same
   * key returns the stored receipt instead of receiving the stock twice. */
  idempotencyKey: string
  lines: PurchaseReceiptLineInput[]
}

interface PurchaseReceiptSourceLineRow extends Record<string, unknown> {
  id: string
  line_number: number
  item_id: string | null
  account_id: string | null
  description: string | null
  quantity: string
  unit: string | null
  unit_price: string
  department_id: string | null
  project_id: string | null
  location_id: string | null
  class_id: string | null
  extra_dims: Record<string, unknown> | null
  stock_location_id: string | null
  quantity_fulfilled: string
  custom: Record<string, unknown> | null
  item_kind: string | null
  item_name: string | null
  has_inventory_profile: boolean
  received_not_billed_account_id: string | null
}

/**
 * Record one immutable goods receipt against a purchase order and bring the
 * stock in within the same transaction (DR inventory / CR received-not-billed
 * at the order price). Advances the order lines' received quantity, which is
 * the ceiling the receipt-governed vendor bill later bills against. Source
 * header and line locks fence concurrent partial receipts; a stable command
 * key makes serial and concurrent retries exactly-once — the same shape as
 * fulfillSalesOrder, on the inbound side.
 */
export async function receivePurchaseOrder(
  orgId: string,
  userId: string,
  sourceId: string,
  input: PurchaseReceiptInput,
): Promise<ConvertResult> {
  if (!(await isFeatureEnabled(orgId, 'orders'))) throw new ConversionError('Orders feature is disabled')
  if (!(await isFeatureEnabled(orgId, 'inventory'))) throw new ConversionError('Inventory is disabled')
  const idempotencyKey = input.idempotencyKey.trim()
  if (idempotencyKey.length < 1 || idempotencyKey.length > 500) {
    throw new ConversionError('Receipt idempotency key must be between 1 and 500 characters')
  }
  if (!isIsoCalendarDate(input.receiptDate)) throw new ConversionError('Receipt date must be YYYY-MM-DD')
  const requested = canonicalFulfillmentLines(input.lines)
  const command = { receiptDate: input.receiptDate, lines: requested }
  return db.transaction(async (tx) => {
    const source = (await tx.execute<SalesFulfillmentSourceRow>(sql`
      select id, kind, status, party_id, currency, fx_rate, document_date, due_date,
             subsidiary_id, department_id, project_id, location_id, class_id,
             extra_dims, memo, billing_method
        from documents
       where id = ${sourceId} and org_id = ${orgId}
       for update
    `)).rows[0]
    if (!source) throw new ConversionError('Purchase order not found')
    if (source.kind !== 'purchase_order') throw new ConversionError('Only a purchase order can be received')
    if (source.status === 'draft') throw new ConversionError('Issue the purchase order before receiving it')
    if (source.status === 'voided') throw new ConversionError('This purchase order is voided')
    if (source.status !== 'approved') throw new ConversionError(`This purchase order is ${source.status}`)

    const replay = (await tx.execute<{ id: string; document_number: string; command_matches: boolean }>(sql`
      select target.id, target.document_number,
             target.custom->'purchaseReceiptCommand' = ${JSON.stringify(command)}::jsonb as command_matches
        from document_links link
        join documents target
          on target.id = link.to_document_id and target.org_id = link.org_id
       where link.org_id = ${orgId} and link.from_document_id = ${sourceId}
         and link.link_type = 'fulfills' and target.kind = ${PURCHASE_RECEIPT_KIND}
         and target.custom->>'receiptIdempotencyKey' = ${idempotencyKey}
       limit 1
    `)).rows[0]
    if (replay) {
      if (!replay.command_matches) {
        throw new ConversionError('Receipt idempotency key was already used with a different receipt', 409)
      }
      return { id: replay.id, documentNumber: replay.document_number, kind: PURCHASE_RECEIPT_KIND, replayed: true }
    }

    const sourceLines = (await tx.execute<PurchaseReceiptSourceLineRow>(sql`
      select dl.id, dl.line_number, dl.item_id, dl.account_id, dl.description,
             dl.quantity, dl.unit, dl.unit_price, dl.department_id, dl.project_id, dl.location_id,
             dl.class_id, dl.extra_dims, dl.stock_location_id, dl.quantity_fulfilled,
             dl.custom, i.kind as item_kind, i.name as item_name,
             profile.item_id is not null as has_inventory_profile,
             profile.received_not_billed_account_id
        from document_lines dl
        left join items i on i.id = dl.item_id and i.org_id = dl.org_id
        left join item_inventory_profiles profile
          on profile.item_id = dl.item_id and profile.org_id = dl.org_id
       where dl.document_id = ${sourceId} and dl.org_id = ${orgId}
       order by dl.line_number
       for update of dl
    `)).rows
    const sourceById = new Map(sourceLines.map((line) => [line.id, line]))
    const selected = requested.map((request) => {
      const line = sourceById.get(request.sourceLineId)
      if (!line) throw new ConversionError(`Purchase-order line ${request.sourceLineId} was not found`)
      if (line.item_id == null || !lineRequiresReceipt(line.item_kind)) {
        throw new ConversionError(
          `Purchase-order line ${line.line_number} is not stock and is billed on a two-way match, not received`,
        )
      }
      if (!line.has_inventory_profile) {
        throw new ConversionError(`Purchase-order line ${line.line_number} is an inventory item without a costing profile`)
      }
      if (!line.received_not_billed_account_id) {
        const itemLabel = line.item_name ? ` (${line.item_name})` : ''
        throw new ConversionError(
          `Purchase-order line ${line.line_number}${itemLabel} cannot be received: the item has no received-not-billed account — set it on the item's costing profile before receiving`,
          422,
          ITEM_MISSING_RNB_ACCOUNT,
          { lineNumber: line.line_number, itemId: line.item_id, itemName: line.item_name },
        )
      }
      const remaining = toQuantityUnits(String(line.quantity)) - toQuantityUnits(String(line.quantity_fulfilled))
      const receiving = toQuantityUnits(request.quantity)
      if (remaining <= 0n) throw new ConversionError(`Purchase-order line ${line.line_number} is already fully received`)
      if (receiving > remaining) {
        throw new ConversionError(
          `Purchase-order line ${line.line_number} has only ${fromQuantityUnits(remaining)} remaining to receive`,
        )
      }
      return { request, line }
    })

    // Same legacy trap as the sales side: a NULL warehouse on a stocked
    // line would fail inside the inventory kernel with a generic error.
    // Refuse up front naming the line and the way forward (F-coord-004).
    const receiptWarehouses = await activeStockLocations(orgId)
    const unwarehousedReceipt = missingOrderLineWarehouses(
      selected.map(({ line }) => ({
        lineNumber: line.line_number,
        itemId: line.item_id,
        hasInventoryProfile: line.has_inventory_profile,
        stockLocationId: line.stock_location_id,
      })),
      receiptWarehouses.length,
    )[0]
    if (unwarehousedReceipt) {
      const details = { lineNumber: unwarehousedReceipt.lineNumber, activeWarehouses: receiptWarehouses.length }
      if (receiptWarehouses.length === 0) {
        throw new ConversionError(
          `Purchase-order line ${unwarehousedReceipt.lineNumber} is a stocked item with no warehouse, and this organization has no active warehouse — create one, assign it to the line, then receive again`,
          422,
          ORDER_LINE_WAREHOUSE_REQUIRED,
          details,
        )
      }
      throw new ConversionError(
        `Purchase-order line ${unwarehousedReceipt.lineNumber} is a stocked item with no warehouse, and this organization has ${receiptWarehouses.length} active warehouses, so receipt cannot choose one — assign a warehouse to the line, then receive again`,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        details,
      )
    }

    const documentNumber = await nextDocumentNumber(orgId, PURCHASE_RECEIPT_KIND, 'RCPT-', source.subsidiary_id)
    const receiptId = randomUUID()
    const custom = { receiptIdempotencyKey: idempotencyKey, purchaseReceiptCommand: command }
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, document_date, currency,
         fx_rate, status, subsidiary_id, department_id, project_id, location_id,
         class_id, extra_dims, billing_method, memo, subtotal, tax_total, total,
         custom, created_by, updated_by)
      values
        (${receiptId}, ${orgId}, ${PURCHASE_RECEIPT_KIND}, ${documentNumber},
         ${source.party_id}, ${input.receiptDate}, ${source.currency}, ${source.fx_rate},
         'draft', ${source.subsidiary_id}, ${source.department_id}, ${source.project_id},
         ${source.location_id}, ${source.class_id}, ${JSON.stringify(source.extra_dims ?? {})}::jsonb,
         ${source.billing_method}, ${source.memo}, '0', '0', '0',
         ${JSON.stringify(custom)}::jsonb, ${userId}, ${userId})
    `)

    // Approved lines are storage-immutable (migration 0034); advancing the
    // received quantity is operational evidence, not a commercial edit. The
    // header is locked for this transaction, so reopen, advance, restore.
    const reopened = (await tx.execute<{ id: string }>(sql`
      update documents set status = 'draft', updated_by = ${userId}
       where id = ${sourceId} and org_id = ${orgId} and status = 'approved'
      returning id
    `)).rows[0]
    if (!reopened) throw new ConversionError('Purchase order changed while it was being received', 409)

    let lineNumber = 1
    for (const { request, line } of selected) {
      // Received at the order price: the amount is the value the receipt
      // credits to received-not-billed and the bill later clears.
      const amount = orderLineAmount(request.quantity, String(line.unit_price))
      const lineCustom = {
        ...(line.custom ?? {}),
        receipt: { sourceLineId: line.id, lotId: request.lotId, serialId: request.serialId },
      }
      await tx.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, item_id, account_id, description,
           quantity, unit, unit_price, amount, tax_amount, department_id,
           project_id, location_id, class_id, extra_dims, stock_location_id,
           is_billable, custom, created_by, updated_by)
        values
          (${orgId}, ${receiptId}, ${lineNumber}, ${line.item_id}, ${line.account_id},
           ${line.description}, ${request.quantity}, ${line.unit}, ${line.unit_price}, ${amount}, '0',
           ${line.department_id}, ${line.project_id}, ${line.location_id}, ${line.class_id},
           ${JSON.stringify(line.extra_dims ?? {})}::jsonb, ${line.stock_location_id}, false,
           ${JSON.stringify(lineCustom)}::jsonb, ${userId}, ${userId})
      `)
      const advanced = (await tx.execute<{ id: string }>(sql`
        update document_lines
           set quantity_fulfilled = quantity_fulfilled + ${request.quantity},
               updated_by = ${userId}
         where id = ${line.id} and org_id = ${orgId}
           and quantity_fulfilled + ${request.quantity} <= quantity
        returning id
      `)).rows[0]
      if (!advanced) {
        throw new ConversionError(`Purchase-order line ${line.line_number} changed while it was being received`, 409)
      }
      lineNumber++
    }

    const restored = (await tx.execute<{ id: string }>(sql`
      update documents set status = 'approved', updated_by = ${userId}
       where id = ${sourceId} and org_id = ${orgId} and status = 'draft'
      returning id
    `)).rows[0]
    if (!restored) throw new ConversionError('Purchase order changed while it was being received', 409)

    await tx.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${sourceId}, ${receiptId}, 'fulfills', ${userId})
    `)
    await applyPurchaseReceiptInventory(tx, orgId, userId, receiptId, input.receiptDate, source.subsidiary_id)
    await tx.execute(sql`
      update documents set status = 'approved', updated_by = ${userId}
       where id = ${receiptId} and org_id = ${orgId}
    `)
    return { id: receiptId, documentNumber, kind: PURCHASE_RECEIPT_KIND }
  })
}

/** Receive every stock line's remaining quantity through the conversion
 * surface, with a key derived from the observed source state so concurrent
 * clicks replay one receipt. Call receivePurchaseOrder directly for explicit
 * partial quantities or lot/serial selections. */
async function receivePurchaseOrderRemainder(
  orgId: string,
  userId: string,
  sourceId: string,
): Promise<ConvertResult> {
  const receiptDate = await businessToday(orgId)
  const rows = (await db.execute<{ id: string; quantity: string; quantity_fulfilled: string; item_id: string | null; item_kind: string | null }>(sql`
    select line.id, line.quantity, line.quantity_fulfilled, line.item_id, i.kind as item_kind
      from document_lines line
      join documents source on source.id = line.document_id and source.org_id = line.org_id
      left join items i on i.id = line.item_id and i.org_id = line.org_id
     where line.org_id = ${orgId} and source.id = ${sourceId}
       and source.kind = 'purchase_order'
     order by line.id
  `)).rows
  const lines = rows.flatMap((line) => {
    if (line.item_id == null || !lineRequiresReceipt(line.item_kind)) return []
    const remaining = toQuantityUnits(line.quantity) - toQuantityUnits(line.quantity_fulfilled)
    return remaining > 0n ? [{ sourceLineId: line.id, quantity: fromQuantityUnits(remaining) }] : []
  })
  if (lines.length === 0) {
    const latest = (await db.execute<{ id: string; document_number: string }>(sql`
      select target.id, target.document_number
        from document_links link
        join documents target on target.id = link.to_document_id and target.org_id = link.org_id
       where link.org_id = ${orgId} and link.from_document_id = ${sourceId}
         and link.link_type = 'fulfills' and target.kind = ${PURCHASE_RECEIPT_KIND}
       order by target.created_at desc, target.id desc
       limit 1
    `)).rows[0]
    if (!latest) throw new ConversionError('This purchase order has no stock lines left to receive')
    return { id: latest.id, documentNumber: latest.document_number, kind: PURCHASE_RECEIPT_KIND, replayed: true }
  }
  const idempotencyKey = `purchase-receipt-remainder:${createHash('sha256')
    .update(JSON.stringify({ sourceId, receiptDate, lines }))
    .digest('hex')}`
  return receivePurchaseOrder(orgId, userId, sourceId, { receiptDate, idempotencyKey, lines })
}

/**
 * Convert an order document into `targetKind`, pulling forward each line's
 * remaining (quantity − quantity_billed). Records a document_links edge and
 * advances quantity_billed on the source lines. Runs in one transaction.
 */
export interface AssignOrderLineWarehouseInput {
  orgId: string
  userId: string
  orderId: string
  kind: 'sales_order' | 'purchase_order'
  lineId: string
  stockLocationId: string
  expectedUpdatedAt: string
}

/**
 * Assign a warehouse to one line of an approved-but-unfulfilled order
 * (F-coord-004). Orders approved before line warehouses existed carry NULL
 * warehouses and their lines are storage-immutable (migration 0034), so
 * fulfillment could never name a location and failed closed with no way
 * forward. Setting the warehouse changes no posted amount — it only routes
 * future shipments/receipts — so this reopens the header inside one
 * transaction (the established fulfill/convert pattern), writes the single
 * column, restores approved, and audits the assignment. Drafts stay on the
 * normal edit path; anything not approved is refused.
 */
export async function assignOrderLineWarehouse(
  input: AssignOrderLineWarehouseInput,
): Promise<{ lineId: string; lineNumber: number; stockLocationId: string }> {
  const orderLabel = input.kind === 'sales_order' ? 'Sales order' : 'Purchase order'
  const lineLabel = input.kind === 'sales_order' ? 'Sales-order line' : 'Purchase-order line'
  if (!isUuid(input.orderId) || !isUuid(input.lineId) || !isUuid(input.stockLocationId)) {
    throw new ConversionError('Invalid order line warehouse assignment', 422)
  }
  return db.transaction(async (tx) => {
    const doc = (await tx.execute<{
      id: string
      kind: string
      status: string
      subsidiary_id: string | null
      updated_at: string
    }>(sql`
      select id, kind, status, subsidiary_id,
             ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at
        from documents
       where id = ${input.orderId} and org_id = ${input.orgId}
       for update
    `)).rows[0]
    if (!doc || doc.kind !== input.kind) throw new ConversionError('Order not found', 404)
    if (doc.status === 'draft') {
      throw new ConversionError(
        `This ${orderLabel.toLowerCase()} is still a draft; set the warehouse by editing the draft`,
        422,
      )
    }
    if (doc.status !== 'approved') throw new ConversionError(`This ${orderLabel.toLowerCase()} is ${doc.status}`, 422)
    if (!isDocumentRevisionToken(input.expectedUpdatedAt) || input.expectedUpdatedAt !== doc.updated_at) {
      throw new ConversionError('this order changed after you opened it; reload and review the latest revision', 409)
    }
    const line = (await tx.execute<{
      id: string
      line_number: number
      item_id: string | null
      stock_location_id: string | null
    }>(sql`
      select id, line_number, item_id, stock_location_id
        from document_lines
       where id = ${input.lineId} and org_id = ${input.orgId} and document_id = ${input.orderId}
       for update
    `)).rows[0]
    if (!line) throw new ConversionError('Order line not found', 404)
    if (line.stock_location_id === input.stockLocationId) {
      return { lineId: line.id, lineNumber: line.line_number, stockLocationId: input.stockLocationId }
    }
    if (!line.item_id) {
      throw new ConversionError(
        `${lineLabel} ${line.line_number} is not a stocked item; a warehouse does not apply`,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        { lineNumber: line.line_number },
      )
    }
    const profiled = (await tx.execute<{ item_id: string }>(sql`
      select item_id from item_inventory_profiles
       where org_id = ${input.orgId} and item_id = ${line.item_id}
    `)).rows[0]
    if (!profiled) {
      throw new ConversionError(
        `${lineLabel} ${line.line_number} is not a stocked item; a warehouse does not apply`,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        { lineNumber: line.line_number },
      )
    }
    // The drawer's own validation reader: the choice must name an active
    // warehouse of this org. Subsidiary admission is checked next with the
    // same rule posting enforces, so the assignment cannot strand the line.
    const resolved = resolveLineStockLocation(line.line_number, line.item_id, input.stockLocationId, {
      active: await activeStockLocations(input.orgId),
      profiled: new Set([line.item_id]),
    })
    if ('error' in resolved) {
      throw new ConversionError(
        resolved.error,
        422,
        ORDER_LINE_WAREHOUSE_REQUIRED,
        { lineNumber: line.line_number },
      )
    }
    const locationId = resolved.locationId ?? input.stockLocationId
    const ctx = await loadSubsidiaryContext(tx, input.orgId)
    try {
      await assertStockLocationAdmitsSubsidiary(tx, input.orgId, ctx, locationId, doc.subsidiary_id ?? ctx.rootId)
    } catch (error) {
      if (error instanceof InventoryOwnershipError) {
        throw new ConversionError(
          error.message,
          403,
          ORDER_LINE_WAREHOUSE_REQUIRED,
          { lineNumber: line.line_number },
        )
      }
      if (error instanceof InventoryError) {
        throw new ConversionError(
          error.message,
          422,
          ORDER_LINE_WAREHOUSE_REQUIRED,
          { lineNumber: line.line_number },
        )
      }
      throw error
    }
    const reopened = (await tx.execute<{ id: string }>(sql`
      update documents
         set status = 'draft', updated_by = ${input.userId}
       where id = ${input.orderId} and org_id = ${input.orgId} and status = 'approved'
      returning id
    `)).rows[0]
    if (!reopened) throw new ConversionError('Order changed while assigning the warehouse', 409)
    await tx.execute(sql`
      update document_lines
         set stock_location_id = ${locationId}, updated_by = ${input.userId}
       where id = ${line.id} and org_id = ${input.orgId}
    `)
    const restored = (await tx.execute<{ id: string }>(sql`
      update documents
         set status = 'approved', updated_by = ${input.userId}
       where id = ${input.orderId} and org_id = ${input.orgId} and status = 'draft'
      returning id
    `)).rows[0]
    if (!restored) throw new ConversionError('Order changed while assigning the warehouse', 409)
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${input.orgId}, 'document_lines', ${line.id}, 'update',
        ${JSON.stringify({
          mode: 'order_line_warehouse_assigned',
          orderId: input.orderId,
          kind: input.kind,
          lineNumber: line.line_number,
          from: line.stock_location_id,
          to: locationId,
        })}::jsonb,
        ${input.userId}
      )
    `)
    return { lineId: line.id, lineNumber: line.line_number, stockLocationId: locationId }
  })
}

export async function convertOrder(
  orgId: string,
  userId: string,
  sourceId: string,
  targetKind: string,
  options: { creditOverrideReason?: string; expectedUpdatedAt?: string } = {},
): Promise<ConvertResult> {
  if (!(await isFeatureEnabled(orgId, 'orders'))) throw new ConversionError('Orders feature is disabled')
  return withOrgTransaction(orgId, async () => db.transaction(async (tx) => {
    if (options.expectedUpdatedAt !== undefined) {
      const source = (await tx.execute<{ revision: string }>(sql`
        select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents
         where id = ${sourceId} and org_id = ${orgId} for update
      `)).rows[0];
      if (!source) throw new ConversionError('Order not found', 404)
      if (!isDocumentRevisionToken(options.expectedUpdatedAt) || options.expectedUpdatedAt !== source.revision) {
        throw new ConversionError('this order changed after you opened it; reload and review the latest revision', 409)
      }
    }
    // Physical movements refuse with the engine's InventoryError (short
    // stock, unwarehoused lines, cross-entity attempts). Those are
    // operator-actionable business refusals, not server faults: wrap them
    // as ConversionErrors so the convert route answers 422/403 with the
    // message the picker needs, the way assign-warehouse already does.
    try {
      if (targetKind === SALES_FULFILLMENT_KIND) {
        return await fulfillSalesOrderRemainder(orgId, userId, sourceId)
      }
      if (targetKind === PURCHASE_RECEIPT_KIND) {
        return await receivePurchaseOrderRemainder(orgId, userId, sourceId)
      }
    } catch (error) {
      if (error instanceof ConversionError) throw error
      if (error instanceof InventoryOwnershipError) throw new ConversionError(error.message, 403)
      if (error instanceof InventoryError) throw new ConversionError(error.message, 422)
      throw error
    }
    const src = (await tx.execute<OrderSourceRow>(sql`
      select id, kind, status, party_id, currency, fx_rate, document_date, due_date,
             subsidiary_id, department_id, project_id, location_id, class_id, extra_dims, memo, billing_method
        from documents where id = ${sourceId} and org_id = ${orgId} for update
    `))
    const doc = src.rows[0]
    if (!doc) throw new ConversionError('Order not found')
    if (!ORDER_KINDS.includes(doc.kind as OrderKind)) throw new ConversionError('Not an order document')
    if (doc.status === 'draft') throw new ConversionError('Issue the order before converting it')
    if (doc.status === 'voided') throw new ConversionError('This order is voided')

    const target = (CONVERSION_TARGETS[doc.kind as OrderKind] || []).find((t) => t.kind === targetKind)
    if (!target) throw new ConversionError(`Cannot convert a ${doc.kind} into ${targetKind}`)

    const lines = (await tx.execute<OrderConvertLineRow>(sql`
      select dl.id, dl.line_number, dl.item_id, dl.account_id, dl.description, dl.quantity, dl.unit,
             dl.unit_price, dl.amount, dl.tax_code_id, dl.tax_group_id, dl.tax_amount,
             dl.department_id, dl.project_id, dl.location_id, dl.class_id, dl.extra_dims,
             dl.stock_location_id, dl.is_billable, dl.quantity_billed, dl.quantity_fulfilled,
             i.kind as item_kind, i.income_account_id as item_income_account_id
        from document_lines dl left join items i on i.id = dl.item_id and i.org_id = dl.org_id
       where dl.document_id = ${sourceId} and dl.org_id = ${orgId}
       order by dl.line_number
       for update of dl
    `))
    // A sales-side line with no account inherits the item's income account so
    // the converted document stays postable (F-t09-012: converted SO lines
    // carried null accounts and their invoices could never post). An explicit
    // line account always wins; the purchase side is untouched.
    const salesSide = doc.kind !== 'purchase_order'
    const convertedAccountOf = (l: { account_id: unknown; item_income_account_id: unknown }): string | null => {
      if (typeof l.account_id === 'string' && l.account_id.length > 0) return l.account_id
      if (salesSide && typeof l.item_income_account_id === 'string' && l.item_income_account_id.length > 0) {
        return l.item_income_account_id
      }
      return null
    }

    // Remaining (un-pulled) quantity per line.
    const remaining = lines.rows
      .map((line) => ({
        line,
        remainder: remainingOrderLine({
          quantity: String(line.quantity),
          quantityBilled: String(line.quantity_billed),
          unitPrice: String(line.unit_price),
          taxAmount: String(line.tax_amount),
        }),
      }))
      .filter((row): row is { line: OrderConvertLineRow; remainder: NonNullable<ReturnType<typeof remainingOrderLine>> } => row.remainder !== null)
    if (remaining.length === 0) throw new ConversionError('Every line is already fully converted')
    // One shared physical-quantity ceiling for both billing legs. A purchase
    // order bills received-and-unbilled stock; a sales order bills shipped-and-
    // unbilled stock. Service/non-stock lines remain two-way matched.
    const fulfillmentGovernedBilling =
      (doc.kind === 'purchase_order' && target.kind === 'vendor_bill') ||
      (doc.kind === 'sales_order' && target.kind === 'customer_invoice')
    const covered = (
      fulfillmentGovernedBilling
        ? remaining.flatMap((row) => {
            const units = billableRemainderQuantityUnits({
              orderedQuantity: String(row.line.quantity),
              billedQuantity: String(row.line.quantity_billed),
              fulfilledQuantity: String(row.line.quantity_fulfilled),
              requiresReceipt: row.line.item_id != null && lineRequiresReceipt(row.line.item_kind ?? null),
            })
            return units > 0n ? [{ ...row, units }] : []
          })
        : remaining.map((row) => ({ ...row, units: toQuantityUnits(row.remainder.quantity) }))
    )
    if (covered.length === 0) throw new ConversionError('Fulfilled quantities do not cover any line yet')
    // Source lines stay. Turning Inventory off must refuse a conversion that
    // would copy inventory / assembly / kit onto the new document.
    if (!(await isFeatureEnabled(orgId, 'inventory'))) {
      const itemIds = [...new Set(
        covered.map((row) => row.line.item_id as string | null).filter((itemId): itemId is string => Boolean(itemId)),
      )]
      for (const itemId of itemIds) {
        const item = (await tx.execute<{ kind: string }>(sql`
          select kind from items where id = ${itemId} and org_id = ${orgId}`))
        if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
          throw new ConversionError('Inventory is disabled')
        }
      }
    }
    // Source lines stay. Turning Equipment off must refuse a conversion that
    // would copy equipment_charge onto the new document.
    if (!(await isFeatureEnabled(orgId, 'equipment'))) {
      const itemIds = [...new Set(
        covered.map((row) => row.line.item_id as string | null).filter((itemId): itemId is string => Boolean(itemId)),
      )]
      for (const itemId of itemIds) {
        const item = (await tx.execute<{ kind: string }>(sql`
          select kind from items where id = ${itemId} and org_id = ${orgId}`))
        if (item.rows[0] && item.rows[0].kind === 'equipment_charge') {
          throw new ConversionError('Equipment is disabled', 404)
        }
      }
    }

    const documentNumber = await nextDocumentNumber(orgId, target.kind, target.prefix, doc.subsidiary_id)
    const isOrder = ORDER_KINDS.includes(target.kind as OrderKind)
    // A quote→sales-order conversion crosses the same authoritative issuance
    // boundary as the sales-order drawer below, so it starts draft and is
    // issued only after the customer credit decision. Other downstream orders
    // retain their established issued status; posting documents start draft.
    const targetStatus = target.kind === 'sales_order' ? 'draft' : isOrder ? 'approved' : 'draft'
    // Keep the source commercial date. A UTC "today" here both shifted the
    // cutoff for orgs behind UTC and dropped the order's own date.
    const documentDate = String(doc.document_date)

    const convertedAmounts: string[] = []
    const convertedTaxes: string[] = []
    const created = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, due_date,
                             currency, fx_rate, status, subsidiary_id, department_id, project_id, location_id,
                             class_id, extra_dims, billing_method, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, ${target.kind}, ${documentNumber}, ${doc.party_id},
              ${documentDate}, ${doc.due_date}, ${doc.currency},
              ${doc.fx_rate}, ${targetStatus}, ${doc.subsidiary_id}, ${doc.department_id}, ${doc.project_id},
              ${doc.location_id}, ${doc.class_id}, ${JSON.stringify(doc.extra_dims ?? {})}::jsonb, ${doc.billing_method}, ${doc.memo},
              '0', '0', '0', ${userId})
      returning id
    `)).rows[0]!
    const newId = created.id

    // Migration 0034 makes approved document lines immutable. Advancing
    // quantity_billed is operational reconciliation state, rather than an
    // edit to the approved commercial source. The source header is already
    // locked for this transaction, so briefly reopen it while the conversion
    // advances its covered lines, then restore the approved status before the
    // transaction can become visible to another caller. Any failure rolls the
    // entire conversion (including this temporary status window) back.
    const reopenSourceForLineAdvances = doc.status === 'approved'
    if (reopenSourceForLineAdvances) {
      const reopened = (await tx.execute<{ id: string }>(sql`
        update documents
           set status = 'draft', updated_by = ${userId}
         where id = ${sourceId} and org_id = ${orgId} and status = 'approved'
        returning id
      `)).rows[0]
      if (!reopened) throw new ConversionError('Order changed while it was being converted', 409)
    }

    let lineNo = 1
    for (const r of covered) {
      const l = r.line
      const remainderUnits = toQuantityUnits(r.remainder.quantity)
      const amount = mulRatio(r.remainder.amount, r.units, remainderUnits)
      const taxAmount = mulRatio(r.remainder.taxAmount, r.units, remainderUnits)
      convertedAmounts.push(amount)
      convertedTaxes.push(taxAmount)
      // The exact billed-quantity advance for this line (see the guarded
      // quantity_billed update below). A void or draft-delete of this child
      // restores precisely this cover to the source line — without it the
      // billed remainder strands and the source can never be re-converted.
      const coveredQty = fromQuantityUnits(r.units)
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit, unit_price, amount, tax_code_id, tax_group_id, tax_amount, department_id, project_id,
              location_id, class_id, extra_dims, stock_location_id, is_billable, custom, created_by)
        values (${orgId}, ${newId}, ${lineNo}, ${l.item_id}, ${convertedAccountOf(l)}, ${l.description},
              ${coveredQty}, ${l.unit}, ${l.unit_price}, ${amount},
              ${l.tax_code_id}, ${l.tax_group_id}, ${taxAmount}, ${l.department_id}, ${l.project_id},
              ${l.location_id}, ${l.class_id}, ${JSON.stringify(l.extra_dims ?? {})}::jsonb, ${l.stock_location_id}, ${l.is_billable},
              ${JSON.stringify({
                // A bill line drawn from a purchase-order line keeps that
                // provenance: bill posting uses it to clear received-not-billed
                // for stock a goods receipt already brought in, instead of
                // receiving the stock a second time.
                ...(doc.kind === 'purchase_order' && target.kind === 'vendor_bill' ? { purchaseOrderLineId: l.id } : {}),
                convertedFrom: { documentId: sourceId, lineId: l.id, quantity: coveredQty },
              })}::jsonb, ${userId})
        returning id
      `))
      const newLineId = inserted.rows[0]!.id
      const originalQty = toQuantityUnits(String(l.quantity))
      if (originalQty !== 0n && (l.tax_code_id || l.tax_group_id)) {
        const components = (await tx.execute<{
          tax_code_id: string
          sequence: number
          rate_percent: string
          taxable_amount: string
          tax_amount: string
          recoverable_amount: string
          nonrecoverable_amount: string
          calculation_type: 'standard' | 'withholding' | 'reverse_charge'
          price_includes_tax: boolean
          compound_on_previous: boolean
          rounding_scale: number
          collected_account_id: string | null
          paid_account_id: string | null
          withholding_account_id: string | null
          overridden: boolean
        }>(sql`
          select tax_code_id, sequence, rate_percent, taxable_amount, tax_amount,
                 recoverable_amount, nonrecoverable_amount, calculation_type,
                 price_includes_tax, compound_on_previous, rounding_scale,
                 collected_account_id, paid_account_id, withholding_account_id, overridden
            from document_line_tax_components
           where document_line_id = ${l.id} and org_id = ${orgId}
           order by sequence
        `))
        if (components.rows.length === 0) {
          throw new ConversionError(
            `line ${l.line_number} has a tax profile but no calculation evidence — reopen the order and save it so tax can be recalculated`,
          )
        }
        await persistLineTaxComponents(tx, {
          orgId,
          documentLineId: newLineId,
          actorId: userId,
          components: components.rows.map((c) => {
            const tax = mulRatio(String(c.tax_amount), r.units, originalQty)
            const recoverable = mulRatio(String(c.recoverable_amount), r.units, originalQty)
            return {
              taxCodeId: c.tax_code_id,
              sequence: c.sequence,
              ratePercent: String(c.rate_percent),
              taxableAmount: mulRatio(String(c.taxable_amount), r.units, originalQty),
              taxAmount: tax,
              recoverableAmount: recoverable,
              // Keep the recovery crossfoot: scale tax and recoverable, then
              // residual is nonrecoverable so rounding cannot break the check.
              nonrecoverableAmount: add(tax, neg(recoverable)),
              calculationType: c.calculation_type,
              priceIncludesTax: c.price_includes_tax,
              compoundOnPrevious: c.compound_on_previous,
              roundingScale: c.rounding_scale,
              collectedAccountId: c.collected_account_id,
              paidAccountId: c.paid_account_id,
              withholdingAccountId: c.withholding_account_id,
              overridden: c.overridden,
            }
          }),
        })
      }
      // Advance billed qty on the source line. The advance is guarded by the
      // same ceiling the remainder was computed from, so a concurrent channel
      // that consumed the cover makes THIS conversion fail whole (the row
      // lock already serializes; the predicate documents and enforces it).
      const receiptRequired = l.item_id != null && lineRequiresReceipt(l.item_kind ?? null)
      const advanced = (await tx.execute<{ id: string }>(sql`
        update document_lines set quantity_billed = quantity_billed + ${coveredQty}, updated_by = ${userId}
         where id = ${l.id} and org_id = ${orgId}
           and quantity_billed + ${coveredQty} <= quantity
           ${receiptRequired ? sql`and quantity_billed + ${coveredQty} <= quantity_fulfilled` : sql``}
        returning id
      `)).rows[0]
      if (!advanced) throw new ConversionError(`Line ${l.line_number} changed while it was being converted`, 409)
      lineNo++
    }

    if (reopenSourceForLineAdvances) {
      const restored = (await tx.execute<{ id: string }>(sql`
        update documents
           set status = 'approved', updated_by = ${userId}
         where id = ${sourceId} and org_id = ${orgId} and status = 'draft'
        returning id
      `)).rows[0]
      if (!restored) throw new ConversionError('Order changed while it was being converted', 409)
    }

    await tx.execute(sql`
      update documents set subtotal = ${sum(convertedAmounts)}, tax_total = ${sum(convertedTaxes)},
             total = ${add(sum(convertedAmounts), sum(convertedTaxes))}, updated_by = ${userId}
      where id = ${newId} and org_id = ${orgId}
    `)

    await tx.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${sourceId}, ${newId}, ${target.link}, ${userId})
    `)

    if (target.kind === 'sales_order') {
      const revision = (await tx.execute<{ updated_at: string }>(sql`
        select ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at from documents where id = ${newId} and org_id = ${orgId}
      `)).rows[0]!.updated_at
      await issueSalesOrder({
        orgId,
        salesOrderId: newId,
        actorId: userId,
        expectedUpdatedAt: revision,
        creditOverrideReason: options.creditOverrideReason,
      })
    }

    const opportunityLink = (await tx.execute<{ opportunity_id: string }>(sql`
      select opportunity_id from crm_opportunity_documents
       where document_id = ${sourceId} and org_id = ${orgId}
    `))
    if (opportunityLink.rows[0]) {
      await tx.execute(sql`
        insert into crm_opportunity_documents (org_id, opportunity_id, document_id, created_by, updated_by)
        values (${orgId}, ${opportunityLink.rows[0].opportunity_id}, ${newId}, ${userId}, ${userId})
        on conflict (document_id) do nothing`)
    }
    if (doc.party_id && ['sales_order', 'customer_invoice', 'customer_credit', 'customer_payment'].includes(target.kind)) {
      await promoteCrmAccount(tx, {
        orgId,
        partyId: doc.party_id,
        actorId: userId,
        toStage: 'customer',
        sourceKind: target.kind,
        sourceId: newId,
      })
    }

    return { id: newId, documentNumber, kind: target.kind }
  }))
}
