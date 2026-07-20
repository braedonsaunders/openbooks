import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { nextDocumentNumber } from './bills'
import { ORDER_KINDS, type OrderKind, CONVERSION_TARGETS } from './order-kinds'
import { promoteCrmAccount } from '@openbooks/engine/src/crm.ts'
import { add, sum } from '@openbooks/engine/src/money.ts'
import { remainingOrderLine } from './order-cycle-math'

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
             department_id, project_id, location_id, class_id, extra_dims, memo, billing_method
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
             amount, tax_code_id, tax_amount, department_id, project_id, location_id, class_id, extra_dims,
             is_billable, quantity_billed
        from document_lines where document_id = ${sourceId} and org_id = ${orgId} order by line_number
    `)) as unknown as { rows: any[] }

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

    const documentNumber = await nextDocumentNumber(orgId, target.kind, target.prefix)
    const isOrder = ORDER_KINDS.includes(target.kind as OrderKind)
    // Downstream orders (quote→SO) start issued; posting docs start as drafts.
    const targetStatus = isOrder ? 'approved' : 'draft'

    const convertedAmounts: string[] = []
    const convertedTaxes: string[] = []
    const [created] = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, due_date,
                             currency, fx_rate, status, department_id, project_id, location_id,
                             class_id, extra_dims, billing_method, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, ${target.kind}, ${documentNumber}, ${doc.party_id},
              ${new Date().toISOString().slice(0, 10)}, ${doc.due_date}, ${doc.currency},
              ${doc.fx_rate}, ${targetStatus}, ${doc.department_id}, ${doc.project_id},
              ${doc.location_id}, ${doc.class_id}, ${JSON.stringify(doc.extra_dims ?? {})}::jsonb, ${doc.billing_method}, ${doc.memo},
              '0', '0', '0', ${userId})
      returning id
    `)).rows as any[]
    const newId = created.id

    let lineNo = 1
    for (const r of remaining) {
      const l = r.line
      const amount = r.remainder.amount
      const taxAmount = r.remainder.taxAmount
      convertedAmounts.push(amount)
      convertedTaxes.push(taxAmount)
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit, unit_price, amount, tax_code_id, tax_amount, department_id, project_id,
              location_id, class_id, extra_dims, is_billable, created_by)
        values (${orgId}, ${newId}, ${lineNo}, ${l.item_id}, ${l.account_id}, ${l.description},
              ${r.remainder.quantity}, ${l.unit}, ${l.unit_price}, ${amount},
              ${l.tax_code_id}, ${taxAmount}, ${l.department_id}, ${l.project_id},
              ${l.location_id}, ${l.class_id}, ${JSON.stringify(l.extra_dims ?? {})}::jsonb, ${l.is_billable}, ${userId})
      `)
      // advance billed qty on the source line
      await tx.execute(sql`
        update document_lines set quantity_billed = quantity_billed + ${r.remainder.quantity}, updated_by = ${userId}
        where id = ${l.id}
      `)
      lineNo++
    }

    await tx.execute(sql`
      update documents set subtotal = ${sum(convertedAmounts)}, tax_total = ${sum(convertedTaxes)},
             total = ${add(sum(convertedAmounts), sum(convertedTaxes))}, updated_by = ${userId}
      where id = ${newId}
    `)

    await tx.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${sourceId}, ${newId}, ${target.link}, ${userId})
    `)

    const opportunityLink = (await tx.execute(sql`
      select opportunity_id from crm_opportunity_documents where document_id = ${sourceId}
    `)) as unknown as { rows: { opportunity_id: string }[] }
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
