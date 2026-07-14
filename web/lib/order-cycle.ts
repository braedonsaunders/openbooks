import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { nextDocumentNumber } from './bills'
import { ORDER_KINDS, type OrderKind, CONVERSION_TARGETS } from './order-kinds'

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
  const cfg = NUMBER_PREFIX[kind]
  const org = (await db.execute(
    sql`select base_currency from orgs where id = ${orgId}`,
  )) as unknown as { rows: { base_currency: string }[] }
  const documentNumber = await nextDocumentNumber(orgId, cfg.kind, cfg.prefix)
  const row = (await db.execute(sql`
    insert into documents (org_id, kind, document_number, document_date, currency, subtotal, tax_total, total, created_by)
    values (${orgId}, ${kind}, ${documentNumber}, ${new Date().toISOString().slice(0, 10)},
            ${org.rows[0]?.base_currency ?? 'CAD'}, '0', '0', '0', ${userId})
    returning id, document_number
  `)) as unknown as { rows: { id: string; document_number: string }[] }
  return row.rows[0]!
}

export class ConversionError extends Error {}

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
  return db.transaction(async (tx) => {
    const src = (await tx.execute(sql`
      select id, kind, status, party_id, currency, fx_rate, document_date, due_date,
             department_id, project_id, location_id, class_id, memo, billing_method
        from documents where id = ${sourceId} and org_id = ${orgId} for update
    `)) as unknown as { rows: any[] }
    const doc = src.rows[0]
    if (!doc) throw new ConversionError('Order not found')
    if (!ORDER_KINDS.includes(doc.kind)) throw new ConversionError('Not an order document')
    if (doc.status === 'draft') throw new ConversionError('Issue the order before converting it')
    if (doc.status === 'voided') throw new ConversionError('This order is voided')

    const target = (CONVERSION_TARGETS[doc.kind as OrderKind] || []).find((t) => t.kind === targetKind)
    if (!target) throw new ConversionError(`Cannot convert a ${doc.kind} into ${targetKind}`)

    const lines = (await tx.execute(sql`
      select id, line_number, item_id, account_id, description, quantity, unit, unit_price,
             amount, tax_code_id, tax_amount, department_id, project_id, location_id, class_id,
             is_billable, quantity_billed
        from document_lines where document_id = ${sourceId} order by line_number
    `)) as unknown as { rows: any[] }

    // Remaining (un-pulled) quantity per line.
    const remaining = lines.rows
      .map((l) => {
        const qty = Number(l.quantity)
        const billed = Number(l.quantity_billed)
        const rem = qty - billed
        const unitTax = qty !== 0 ? Number(l.tax_amount) / qty : 0
        return { line: l, rem, unitTax }
      })
      .filter((r) => r.rem > 0.00005)
    if (remaining.length === 0) throw new ConversionError('Every line is already fully converted')

    const documentNumber = await nextDocumentNumber(orgId, target.kind, target.prefix)
    const isOrder = ORDER_KINDS.includes(target.kind as OrderKind)
    // Downstream orders (quote→SO) start issued; posting docs start as drafts.
    const targetStatus = isOrder ? 'approved' : 'draft'

    let subtotal = 0
    let taxTotal = 0
    const [created] = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, due_date,
                             currency, fx_rate, status, department_id, project_id, location_id,
                             class_id, billing_method, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, ${target.kind}, ${documentNumber}, ${doc.party_id},
              ${new Date().toISOString().slice(0, 10)}, ${doc.due_date}, ${doc.currency},
              ${doc.fx_rate}, ${targetStatus}, ${doc.department_id}, ${doc.project_id},
              ${doc.location_id}, ${doc.class_id}, ${doc.billing_method}, ${doc.memo},
              '0', '0', '0', ${userId})
      returning id
    `)).rows as any[]
    const newId = created.id

    let lineNo = 1
    for (const r of remaining) {
      const l = r.line
      const unitPrice = Number(l.unit_price)
      const amount = r.rem * unitPrice
      const taxAmount = r.unitTax * r.rem
      subtotal += amount
      taxTotal += taxAmount
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit, unit_price, amount, tax_code_id, tax_amount, department_id, project_id,
              location_id, class_id, is_billable, created_by)
        values (${orgId}, ${newId}, ${lineNo}, ${l.item_id}, ${l.account_id}, ${l.description},
              ${r.rem.toFixed(4)}, ${l.unit}, ${unitPrice.toFixed(4)}, ${amount.toFixed(4)},
              ${l.tax_code_id}, ${taxAmount.toFixed(4)}, ${l.department_id}, ${l.project_id},
              ${l.location_id}, ${l.class_id}, ${l.is_billable}, ${userId})
      `)
      // advance billed qty on the source line
      await tx.execute(sql`
        update document_lines set quantity_billed = quantity_billed + ${r.rem.toFixed(4)}, updated_by = ${userId}
        where id = ${l.id}
      `)
      lineNo++
    }

    await tx.execute(sql`
      update documents set subtotal = ${subtotal.toFixed(4)}, tax_total = ${taxTotal.toFixed(4)},
             total = ${(subtotal + taxTotal).toFixed(4)}, updated_by = ${userId}
      where id = ${newId}
    `)

    await tx.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${sourceId}, ${newId}, ${target.link}, ${userId})
    `)

    return { id: newId, documentNumber, kind: target.kind }
  })
}
