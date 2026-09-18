import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add } from '@openbooks/engine/src/money.ts'

export type ScheduleLineRow = {
  period_name: string
  period_ends_on: string
  planned_amount: string
  recognized_amount: string | null
  journal_entry_id: string | null
};

export interface ObligationRow {
  id: string
  description: string
  allocated_price: string
  recognition_starts_on: string | null
  recognition_ends_on: string | null
  status: string
  method: string
  rule_name: string
  /** Fair-value range review: set when the allocated per-unit price fell
   *  outside the matched fair value price's [low, high] range. */
  fair_value_flag: 'below_range' | 'above_range' | null
  fair_value_low: string | null
  fair_value_high: string | null
  planned: string
  recognized: string
  lines: ScheduleLineRow[]
}

export interface ContractPayload {
  contract: {
    id: string
    contract_number: string
    customer: string
    status: string
    currency: string | null
    total_transaction_price: string
    starts_on: string | null
    ends_on: string | null
    /**
     * The source customer invoice for invoice-sourced contracts (one contract
     * per invoice by construction). Null for project percent-complete
     * contracts, which have no invoice and nothing voidable. Carries the
     * cancellation target: the drawer offers Cancel recognition only when
     * this names a live invoice on an active contract.
     */
    sourceInvoiceId: string | null
    sourceInvoiceNumber: string | null
  }
  obligations: ObligationRow[]
}

/**
 * Load a revenue contract with its obligations and each obligation's primary-book
 * recognition schedule lines — the operational drill-down for the drawer.
 */
export async function loadContract(id: string, orgId: string): Promise<ContractPayload | null> {
  const cRes = (await db.execute<any>(sql`
    select c.id, c.contract_number, c.status, c.currency, c.total_transaction_price, c.starts_on, c.ends_on,
           coalesce(p.display_name, '—') as customer
      from revenue_contracts c
      left join parties p on p.id = c.customer_id and p.org_id = c.org_id
     where c.id = ${id} and c.org_id = ${orgId}`))
  const contract = cRes.rows[0]
  if (!contract) return null

  // One contract per invoice by construction (revenueContractPostingEffectKey),
  // so at most one source invoice exists; project contracts have none.
  const invRes = (await db.execute<{ id: string; document_number: string }>(sql`
    select inv.id, inv.document_number
      from performance_obligations o
      join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
      join documents inv on inv.id = dl.document_id and inv.org_id = dl.org_id
       and inv.kind = 'customer_invoice'
     where o.contract_id = ${id} and o.org_id = ${orgId}
     order by inv.document_number
     limit 1`))
  contract.sourceInvoiceId = invRes.rows[0]?.id ?? null
  contract.sourceInvoiceNumber = invRes.rows[0]?.document_number ?? null

  const oRes = (await db.execute<any>(sql`
    select o.id, o.description, o.allocated_price, o.recognition_starts_on, o.recognition_ends_on, o.status,
           o.fair_value_flag, o.fair_value_low, o.fair_value_high,
           r.method, r.name as rule_name
      from performance_obligations o
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.contract_id = ${id} and o.org_id = ${orgId}
     order by o.created_at`))

  const obligations: ObligationRow[] = []
  for (const o of oRes.rows) {
    const lRes = (await db.execute<ScheduleLineRow>(sql`
      select p.name as period_name, p.ends_on as period_ends_on,
             l.planned_amount, l.recognized_amount, l.journal_entry_id
        from recognition_schedules s
        join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_primary
        join recognition_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
       where s.obligation_id = ${o.id} and s.org_id = ${orgId}
       order by l.sequence`))
    const planned = lRes.rows.reduce((a, r) => add(a, String(r.planned_amount ?? '0')), '0')
    const recognized = lRes.rows.reduce(
      (a, r) => (r.journal_entry_id ? add(a, String(r.recognized_amount ?? '0')) : a),
      '0',
    )
    obligations.push({
      ...o,
      planned,
      recognized,
      lines: lRes.rows,
    })
  }

  return { contract, obligations }
}
