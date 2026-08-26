import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { nextDocumentNumber, persistLineTaxComponents } from './bills'
import {
  ORDER_KINDS,
  SALES_FULFILLMENT_KIND,
  type OrderKind,
  CONVERSION_TARGETS,
} from './order-kinds'
import { promoteCrmAccount } from '@openbooks/engine/src/crm.ts'
import { add, fromUnits, mulRatio, neg, sum, toUnits } from '@openbooks/engine/src/money.ts'
import { billableRemainderUnits, lineRequiresReceipt } from '@openbooks/engine/src/ap-capture-service.ts'
import { remainingOrderLine } from './order-cycle-math'
import { isFeatureEnabled } from './features'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { applySalesFulfillmentInventoryIssues } from '@openbooks/engine/src/inventory.ts'

export { ORDER_KINDS, CONVERSION_TARGETS }
export type { OrderKind }

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
  constructor(message: string, readonly status = 422) {
    super(message)
    this.name = 'ConversionError'
  }
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
      const units = toUnits(line.quantity)
      if (units <= 0n) throw new Error('non-positive')
      quantity = fromUnits(units)
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
      const remaining = toUnits(String(line.quantity)) - toUnits(String(line.quantity_fulfilled))
      const shipping = toUnits(request.quantity)
      if (remaining <= 0n) throw new ConversionError(`Sales-order line ${line.line_number} is already fully fulfilled`)
      if (shipping > remaining) {
        throw new ConversionError(
          `Sales-order line ${line.line_number} has only ${fromUnits(remaining)} remaining to fulfill`,
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
    const remaining = toUnits(line.quantity) - toUnits(line.quantity_fulfilled)
    return remaining > 0n
      ? [{ sourceLineId: line.id, quantity: fromUnits(remaining) }]
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

/**
 * Convert an order document into `targetKind`, pulling forward each line's
 * remaining (quantity − quantity_billed). Records a document_links edge and
 * advances quantity_billed on the source lines. Runs in one transaction.
 */
export async function convertOrder(
  orgId: string,
  userId: string,
  sourceId: string,
  targetKind: string,
): Promise<ConvertResult> {
  if (!(await isFeatureEnabled(orgId, 'orders'))) throw new ConversionError('Orders feature is disabled')
  if (targetKind === SALES_FULFILLMENT_KIND) {
    return fulfillSalesOrderRemainder(orgId, userId, sourceId)
  }
  return db.transaction(async (tx) => {
    const src = (await tx.execute<any>(sql`
      select id, kind, status, party_id, currency, fx_rate, document_date, due_date,
             subsidiary_id, department_id, project_id, location_id, class_id, extra_dims, memo, billing_method
        from documents where id = ${sourceId} and org_id = ${orgId} for update
    `))
    const doc = src.rows[0]
    if (!doc) throw new ConversionError('Order not found')
    if (!ORDER_KINDS.includes(doc.kind)) throw new ConversionError('Not an order document')
    if (doc.status === 'draft') throw new ConversionError('Issue the order before converting it')
    if (doc.status === 'voided') throw new ConversionError('This order is voided')

    const target = (CONVERSION_TARGETS[doc.kind as OrderKind] || []).find((t) => t.kind === targetKind)
    if (!target) throw new ConversionError(`Cannot convert a ${doc.kind} into ${targetKind}`)

    const lines = (await tx.execute(sql`
      select dl.id, dl.line_number, dl.item_id, dl.account_id, dl.description, dl.quantity, dl.unit,
             dl.unit_price, dl.amount, dl.tax_code_id, dl.tax_group_id, dl.tax_amount,
             dl.department_id, dl.project_id, dl.location_id, dl.class_id, dl.extra_dims,
             dl.stock_location_id, dl.is_billable, dl.quantity_billed, dl.quantity_fulfilled,
             i.kind as item_kind
        from document_lines dl left join items i on i.id = dl.item_id and i.org_id = dl.org_id
       where dl.document_id = ${sourceId} and dl.org_id = ${orgId}
       order by dl.line_number
       for update of dl
    `))

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
      .filter((row): row is { line: any; remainder: NonNullable<ReturnType<typeof remainingOrderLine>> } => row.remainder !== null)
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
            const units = billableRemainderUnits({
              orderedQuantity: String(row.line.quantity),
              billedQuantity: String(row.line.quantity_billed),
              fulfilledQuantity: String(row.line.quantity_fulfilled),
              itemId: row.line.item_id ?? null,
              itemKind: row.line.item_kind ?? null,
            })
            return units > 0n ? [{ ...row, units }] : []
          })
        : remaining.map((row) => ({ ...row, units: toUnits(row.remainder.quantity) }))
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
    // Downstream orders (quote→SO) start issued; posting docs start as drafts.
    const targetStatus = isOrder ? 'approved' : 'draft'
    // Keep the source commercial date. A UTC "today" here both shifted the
    // cutoff for orgs behind UTC and dropped the order's own date.
    const documentDate = String(doc.document_date)

    const convertedAmounts: string[] = []
    const convertedTaxes: string[] = []
    const [created] = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, due_date,
                             currency, fx_rate, status, subsidiary_id, department_id, project_id, location_id,
                             class_id, extra_dims, billing_method, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, ${target.kind}, ${documentNumber}, ${doc.party_id},
              ${documentDate}, ${doc.due_date}, ${doc.currency},
              ${doc.fx_rate}, ${targetStatus}, ${doc.subsidiary_id}, ${doc.department_id}, ${doc.project_id},
              ${doc.location_id}, ${doc.class_id}, ${JSON.stringify(doc.extra_dims ?? {})}::jsonb, ${doc.billing_method}, ${doc.memo},
              '0', '0', '0', ${userId})
      returning id
    `)).rows as unknown as [any]
    const newId = created.id

    let lineNo = 1
    for (const r of covered) {
      const l = r.line
      const remainderUnits = toUnits(r.remainder.quantity)
      const amount = mulRatio(r.remainder.amount, r.units, remainderUnits)
      const taxAmount = mulRatio(r.remainder.taxAmount, r.units, remainderUnits)
      convertedAmounts.push(amount)
      convertedTaxes.push(taxAmount)
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit, unit_price, amount, tax_code_id, tax_group_id, tax_amount, department_id, project_id,
              location_id, class_id, extra_dims, stock_location_id, is_billable, created_by)
        values (${orgId}, ${newId}, ${lineNo}, ${l.item_id}, ${l.account_id}, ${l.description},
              ${fromUnits(r.units)}, ${l.unit}, ${l.unit_price}, ${amount},
              ${l.tax_code_id}, ${l.tax_group_id}, ${taxAmount}, ${l.department_id}, ${l.project_id},
              ${l.location_id}, ${l.class_id}, ${JSON.stringify(l.extra_dims ?? {})}::jsonb, ${l.stock_location_id}, ${l.is_billable}, ${userId})
        returning id
      `))
      const newLineId = inserted.rows[0]!.id
      const originalQty = toUnits(String(l.quantity))
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
      const coveredQty = fromUnits(r.units)
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

    await tx.execute(sql`
      update documents set subtotal = ${sum(convertedAmounts)}, tax_total = ${sum(convertedTaxes)},
             total = ${add(sum(convertedAmounts), sum(convertedTaxes))}, updated_by = ${userId}
      where id = ${newId} and org_id = ${orgId}
    `)

    await tx.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${sourceId}, ${newId}, ${target.link}, ${userId})
    `)

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
  })
}
