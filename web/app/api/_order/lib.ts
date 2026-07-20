import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { OrderKind } from '../../../lib/order-cycle'

/**
 * Shared loader + line-save helpers for the order-cycle documents
 * (quote / sales_order / purchase_order). These live in `documents` with
 * `document_lines`, but unlike AR/AP they are quantity × unit_price line
 * models (never posting), track `quantity_billed` for partial-conversion
 * progress, and expose `document_links` (origin + converted-into edges).
 */

export interface OrderLineInput {
  itemId?: string | null
  accountId?: string | null
  description?: string | null
  quantity?: string | null
  unit?: string | null
  unitPrice?: string | null
  taxCodeId?: string | null
  departmentId?: string | null
  projectId?: string | null
  extraDims?: Record<string, string | null>
}

/** Latest effective rate per tax code, as of now. */
async function taxRateMap(orgId: string): Promise<Map<string, number>> {
  const rates = (await db.execute(sql`
    select tc.id, coalesce(tr.rate_percent, 0) as rate
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${orgId} and tax_code_id = tc.id and effective_from <= now()
         order by effective_from desc limit 1) tr on true
     where tc.org_id = ${orgId}
  `)) as unknown as { rows: { id: string; rate: string }[] }
  return new Map(rates.rows.map((r) => [r.id, Number(r.rate)]))
}

/** qty × price per line → per-line amount + tax + document totals. */
export function computeOrderTotals(lines: OrderLineInput[], rateByCode: Map<string, number>) {
  const computed = lines.map((l) => {
    const qty = Number(l.quantity ?? '0')
    const price = Number(l.unitPrice ?? '0')
    const amount = Math.round(qty * price * 100) / 100
    const rate = l.taxCodeId ? (rateByCode.get(l.taxCodeId) ?? 0) : 0
    const taxAmount = Math.round(amount * rate) / 100
    return { ...l, amount: amount.toFixed(2), taxAmount: taxAmount.toFixed(2) }
  })
  const subtotal = computed.reduce((a, l) => a + Number(l.amount), 0)
  const taxTotal = computed.reduce((a, l) => a + Number(l.taxAmount), 0)
  return {
    lines: computed,
    subtotal: subtotal.toFixed(2),
    taxTotal: taxTotal.toFixed(2),
    total: (subtotal + taxTotal).toFixed(2),
  }
}

export { taxRateMap as orderTaxRateMap }

/**
 * Full order payload for the drawer: header (with party name resolved), lines
 * (with item/account/tax display names resolved for read-only rendering), and
 * the document_links graph (origin + converted-into edges).
 */
export async function loadOrder(id: string, orgId: string, kind: OrderKind) {
  const doc = (await db.execute(sql`
    select d.*, p.display_name as party_name
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.id = ${id} and d.org_id = ${orgId} and d.kind = ${kind}
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!doc.rows[0]) return null

  const lines = (await db.execute(sql`
    select l.id, l.line_number, l.item_id, l.account_id, l.description, l.quantity, l.unit,
           l.unit_price, l.amount, l.tax_code_id, l.tax_amount, l.quantity_billed,
           l.department_id, l.project_id, l.extra_dims,
           i.name as item_name, a.number as account_number, a.name as account_name, tc.code as tax_code
      from document_lines l
      left join items i on i.id = l.item_id and i.org_id = l.org_id
      left join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join tax_codes tc on tc.id = l.tax_code_id and tc.org_id = l.org_id
     where l.document_id = ${id} and l.org_id = ${orgId}
     order by l.line_number
  `)) as unknown as { rows: Record<string, unknown>[] }

  // Origin (this doc was created from …) and converted-into (this doc → …) edges.
  const links = (await db.execute(sql`
    select 'from' as direction, dl.link_type, d2.id, d2.kind, d2.document_number, d2.status
      from document_links dl
      join documents d2 on d2.id = dl.from_document_id and d2.org_id = dl.org_id
     where dl.to_document_id = ${id} and dl.org_id = ${orgId}
    union all
    select 'to' as direction, dl.link_type, d2.id, d2.kind, d2.document_number, d2.status
      from document_links dl
      join documents d2 on d2.id = dl.to_document_id and d2.org_id = dl.org_id
     where dl.from_document_id = ${id} and dl.org_id = ${orgId}
    order by 1
  `)) as unknown as { rows: Record<string, unknown>[] }

  return { doc: doc.rows[0], lines: lines.rows, links: links.rows }
}
