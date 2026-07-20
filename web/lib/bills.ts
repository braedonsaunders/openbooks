import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, sum } from '@openbooks/engine/src/money.ts'
import { resolveLineTax } from '@openbooks/engine/src/tax.ts'
import { resolveOrgId } from './org-scope'

/** Latest effective rate per tax code, as of now. */
export async function taxRateMap(orgId?: string): Promise<Map<string, number>> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const rates = (await db.execute(sql`
    select tc.id, coalesce(tr.rate_percent, 0) as rate
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${resolvedOrgId} and tax_code_id = tc.id and effective_from <= now()
         order by effective_from desc limit 1) tr on true
     where tc.org_id = ${resolvedOrgId}
  `)) as unknown as { rows: { id: string; rate: string }[] }
  return new Map(rates.rows.map((r) => [r.id, Number(r.rate)]))
}

export interface BillLineInput {
  accountId: string
  description?: string | null
  amount: string
  taxCodeId?: string | null
  /** Manual tax override: when true, `taxAmount` is honored instead of computed. */
  taxOverridden?: boolean
  taxAmount?: string | null
}

/** Pre-tax lines → per-line tax + document totals. Honors manual overrides. */
export function computeBillTotals(lines: BillLineInput[], rateByCode: Map<string, number>) {
  const computed = lines.map((l) => {
    const rate = l.taxCodeId ? (rateByCode.get(l.taxCodeId) ?? 0) : 0
    const res = resolveLineTax(l.amount, rate, { overridden: l.taxOverridden, taxAmount: l.taxAmount })
    return { ...l, taxAmount: res.taxAmount, taxOverridden: res.overridden }
  })
  const subtotal = sum(computed.map((l) => l.amount))
  const taxTotal = sum(computed.map((l) => l.taxAmount))
  return { lines: computed, subtotal, taxTotal, total: add(subtotal, taxTotal) }
}

export async function nextDocumentNumber(orgId: string, kind: string, prefix: string, subsidiaryId?: string | null) {
  const requested = subsidiaryId ?? ((await db.execute(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null`)) as any).rows[0]?.id ?? null
  const configured = requested
    ? ((await db.execute(sql`
        select 1 from number_sequences
         where org_id = ${orgId} and document_kind = ${kind} and subsidiary_id = ${requested}
         limit 1`)) as any).rows.length > 0
    : false
  const sequenceSubsidiaryId = configured ? requested : null
  const seq = (await db.execute(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${sequenceSubsidiaryId}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] }
  const s = seq.rows[0]!
  return `${s.prefix}${String(s.next_number).padStart(s.padding, '0')}`
}

/** Full bill payload for the drawer: header + lines. */
export async function loadBill(id: string, orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const doc = (await db.execute(sql`
    select d.*, p.display_name as vendor_name, e.id as entry_id
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
     where d.id = ${id} and d.org_id = ${resolvedOrgId} and d.kind = 'vendor_bill'
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!doc.rows[0]) return null
  const lines = (await db.execute(sql`
    select l.id, l.line_number, l.account_id, l.description, l.amount, l.tax_code_id, l.tax_amount,
           l.tax_overridden, l.department_id, l.project_id, l.custom
      from document_lines l
     where l.document_id = ${id} and l.org_id = ${resolvedOrgId}
     order by l.line_number
  `)) as unknown as { rows: Record<string, unknown>[] }
  return { doc: doc.rows[0], lines: lines.rows }
}
