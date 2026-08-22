import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, mul, normalizeDecimal, normalizeMoney, sum } from '@openbooks/engine/src/money.ts'
import { computeLineTaxes } from '@openbooks/engine/src/tax.ts'
import { taxProfileMap, type TaxProfiles } from '../../../lib/bills'
import { canonicalDecimal } from '../../../lib/exact-decimal'
import type { OrderKind } from '../../../lib/order-cycle'

/** Exact numeric(19,4) money string, or 'invalid'. */
export function exactOrderMoney(v: unknown): string | 'invalid' {
  const exact = canonicalDecimal(v, 4)
  if (exact === null) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

/** Quantity columns are numeric(28,8); do not force ledger money scale. */
export function exactOrderQuantity(v: unknown): string | 'invalid' {
  const exact = canonicalDecimal(v, 8)
  if (exact === null) return 'invalid'
  try {
    return normalizeDecimal(exact, 8)
  } catch {
    return 'invalid'
  }
}

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
  taxGroupId?: string | null
  departmentId?: string | null
  projectId?: string | null
  extraDims?: Record<string, string | null>
}

/** qty × price per line → per-line amount + tax + document totals. */
export function computeOrderTotals(lines: OrderLineInput[], profiles: TaxProfiles) {
  const computed = lines.map((l) => {
    if (l.taxCodeId && l.taxGroupId) throw new Error('select either a tax code or a tax group, not both')
    const inputAmount = mul(l.quantity ?? '0', l.unitPrice ?? '0')
    const config = l.taxGroupId
      ? profiles.groups.get(l.taxGroupId)
      : l.taxCodeId
        ? profiles.codes.get(l.taxCodeId)
        : []
    if ((l.taxCodeId || l.taxGroupId) && !config) throw new Error('selected tax profile is inactive or has no effective rate')
    const result = computeLineTaxes(inputAmount, config ?? [])
    return {
      ...l,
      amount: result.netAmount,
      taxInputAmount: result.inputAmount,
      taxAmount: result.taxTotal,
      taxComponents: result.components,
    }
  })
  const subtotal = sum(computed.map((line) => line.amount))
  const taxTotal = sum(computed.map((line) => line.taxAmount))
  return {
    lines: computed,
    subtotal,
    taxTotal,
    total: add(subtotal, taxTotal),
  }
}

export { taxProfileMap as orderTaxProfileMap }

/**
 * Full order payload for the drawer: header (with party name resolved), lines
 * (with item/account/tax display names resolved for read-only rendering), and
 * the document_links graph (origin + converted-into edges).
 */
export async function loadOrder(id: string, orgId: string, kind: OrderKind) {
  const doc = (await db.execute<Record<string, unknown>>(sql`
    select d.*, p.display_name as party_name
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where d.id = ${id} and d.org_id = ${orgId} and d.kind = ${kind}
  `))
  if (!doc.rows[0]) return null

  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.id, l.line_number, l.item_id, l.account_id, l.description, l.quantity, l.unit,
           l.unit_price, l.amount, l.tax_code_id, l.tax_group_id, l.tax_input_amount,
           l.tax_amount, l.quantity_billed,
           l.department_id, l.project_id, l.extra_dims,
           i.name as item_name, a.number as account_number, a.name as account_name, tc.code as tax_code
      from document_lines l
      left join items i on i.id = l.item_id and i.org_id = l.org_id
      left join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join tax_codes tc on tc.id = l.tax_code_id and tc.org_id = l.org_id
     where l.document_id = ${id} and l.org_id = ${orgId}
     order by l.line_number
  `))

  // Origin (this doc was created from …) and converted-into (this doc → …) edges.
  const links = (await db.execute<Record<string, unknown>>(sql`
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
  `))

  return { doc: doc.rows[0], lines: lines.rows, links: links.rows }
}
