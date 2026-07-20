import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { resolveOrgId } from './org-scope'

/**
 * AR (customer invoice) helpers. Shared math lives in lib/bills.ts —
 * nextDocumentNumber / computeBillTotals / taxRateMap are document-kind
 * agnostic and are imported from there by the invoice API routes. Only the
 * AR-specific loader lives here.
 */

/**
 * Full invoice payload for the drawer: header + lines. For posted invoices
 * the applied amount is summed from `applications` rows targeting the posted
 * entry's AR open-item line, and `balance_due` = total − applied.
 */
export async function loadInvoice(id: string, orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const doc = (await db.execute(sql`
    select d.*, p.display_name as customer_name, e.id as entry_id,
           case when d.status = 'posted' then ap.applied end as applied,
           case when d.status = 'posted' then d.total - ap.applied end as balance_due
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
      left join lateral (
        select coalesce(sum(a.amount), 0) as applied
          from journal_lines jl
          join applications a on a.org_id = jl.org_id and a.to_line_id = jl.id and a.unapplied_at is null
         where jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
      ) ap on true
     where d.id = ${id} and d.org_id = ${resolvedOrgId} and d.kind = 'customer_invoice'
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
