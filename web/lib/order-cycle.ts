import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { nextDocumentNumber, persistLineTaxComponents } from './bills'
import { ORDER_KINDS, type OrderKind, CONVERSION_TARGETS } from './order-kinds'
import { promoteCrmAccount } from '@openbooks/engine/src/crm.ts'
import { add, mulRatio, neg, sum, toUnits } from '@openbooks/engine/src/money.ts'
import { remainingOrderLine } from './order-cycle-math'
import { isFeatureEnabled } from './features'
import { businessToday } from '@openbooks/engine/src/business-date.ts'

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
      select id, line_number, item_id, account_id, description, quantity, unit, unit_price,
             amount, tax_code_id, tax_group_id, tax_amount, department_id, project_id, location_id, class_id, extra_dims,
             is_billable, quantity_billed
        from document_lines where document_id = ${sourceId} and org_id = ${orgId} order by line_number
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
    // Source lines stay. Turning Inventory off must refuse a conversion that
    // would copy inventory / assembly / kit onto the new document.
    if (!(await isFeatureEnabled(orgId, 'inventory'))) {
      const itemIds = [...new Set(
        remaining.map((row) => row.line.item_id as string | null).filter((itemId): itemId is string => Boolean(itemId)),
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
        remaining.map((row) => row.line.item_id as string | null).filter((itemId): itemId is string => Boolean(itemId)),
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
    for (const r of remaining) {
      const l = r.line
      const amount = r.remainder.amount
      const taxAmount = r.remainder.taxAmount
      convertedAmounts.push(amount)
      convertedTaxes.push(taxAmount)
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit, unit_price, amount, tax_code_id, tax_group_id, tax_amount, department_id, project_id,
              location_id, class_id, extra_dims, is_billable, created_by)
        values (${orgId}, ${newId}, ${lineNo}, ${l.item_id}, ${l.account_id}, ${l.description},
              ${r.remainder.quantity}, ${l.unit}, ${l.unit_price}, ${amount},
              ${l.tax_code_id}, ${l.tax_group_id}, ${taxAmount}, ${l.department_id}, ${l.project_id},
              ${l.location_id}, ${l.class_id}, ${JSON.stringify(l.extra_dims ?? {})}::jsonb, ${l.is_billable}, ${userId})
        returning id
      `))
      const newLineId = inserted.rows[0]!.id
      const originalQty = toUnits(String(l.quantity))
      const remainingQty = toUnits(r.remainder.quantity)
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
            const tax = mulRatio(String(c.tax_amount), remainingQty, originalQty)
            const recoverable = mulRatio(String(c.recoverable_amount), remainingQty, originalQty)
            return {
              taxCodeId: c.tax_code_id,
              sequence: c.sequence,
              ratePercent: String(c.rate_percent),
              taxableAmount: mulRatio(String(c.taxable_amount), remainingQty, originalQty),
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
      // advance billed qty on the source line
      await tx.execute(sql`
        update document_lines set quantity_billed = quantity_billed + ${r.remainder.quantity}, updated_by = ${userId}
        where id = ${l.id} and org_id = ${orgId}
      `)
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
