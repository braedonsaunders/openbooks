import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { dateOrFalse, pushCustomFieldFilter, uuidOrFalse } from "../list-query";

/* ------------------------------------------------------------------ */
/* Revenue contracts                                                   */
/* ------------------------------------------------------------------ */

export const REVENUE_CONTRACT_BASE_JOINS = sql`
  left join parties revenue_customer on revenue_customer.id=rc.customer_id and revenue_customer.org_id=rc.org_id
  left join lateral (
    select coalesce(sum(case when l.superseded_by_change_id is not null or l.reversal_journal_entry_id is not null then 0 when l.journal_entry_id is not null then coalesce(l.recognized_amount,0) else l.planned_amount end), 0) as planned,
           coalesce(sum(l.recognized_amount) filter (where l.journal_entry_id is not null and l.reversal_journal_entry_id is null), 0) as recognized
      from performance_obligations o
      join recognition_schedules s on s.obligation_id=o.id and s.org_id=o.org_id
      join accounting_books bk on bk.id=s.book_id and bk.org_id=s.org_id and bk.is_primary
      join recognition_schedule_lines l on l.schedule_id=s.id and l.org_id=s.org_id
     where o.contract_id=rc.id and o.org_id=rc.org_id
  ) revenue_rollup on true`

const REVENUE_DEFERRED_EXPR = sql`revenue_rollup.planned - revenue_rollup.recognized`

export const REVENUE_CONTRACT_BUILT_IN_EXPR: Record<string, SQL> = {
  contract_number: sql`rc.contract_number`,
  customer_name: sql`revenue_customer.display_name`,
  total_price: sql`rc.total_transaction_price`,
  recognized: sql`revenue_rollup.recognized`,
  deferred: REVENUE_DEFERRED_EXPR,
  starts_on: sql`rc.starts_on`,
  ends_on: sql`rc.ends_on`,
  status: sql`rc.status`,
}

export const REVENUE_CONTRACT_SORTS: Record<string, SQL> = {
  number: sql`rc.contract_number`,
  customer: sql`revenue_customer.display_name`,
  total: sql`rc.total_transaction_price`,
  recognized: sql`revenue_rollup.recognized`,
  deferred: REVENUE_DEFERRED_EXPR,
  start: sql`rc.starts_on`,
  end: sql`rc.ends_on`,
  status: sql`rc.status`,
}

function revenueContractFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  if (clause.key === 'status') {
    if (clause.operator === 'eq') return sql`rc.status = ${value}`
    if (clause.operator === 'ne') return sql`rc.status <> ${value}`
  }
  if (clause.key === 'customer_id') {
    const refused = uuidOrFalse(value)
    if (refused) return refused
    if (clause.operator === 'eq') return sql`rc.customer_id = ${value}`
    if (clause.operator === 'ne') return sql`rc.customer_id <> ${value}`
  }
  if (clause.key === 'starts_on' || clause.key === 'ends_on') {
    const column = clause.key === 'starts_on' ? sql`rc.starts_on` : sql`rc.ends_on`
    const refused = dateOrFalse(value)
    if (refused) return refused
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'gte') return sql`${column} >= ${value}`
    if (clause.operator === 'lte') return sql`${column} <= ${value}`
    if (clause.operator === 'between') {
      const refusedTo = dateOrFalse(String(clause.to ?? ''))
      if (refusedTo) return refusedTo
      return sql`${column} between ${value} and ${String(clause.to ?? '')}`
    }
  }
  return null
}

export function revenueContractWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string, allowedSubsidiaryIds?: Set<string> | null): SQL {
  const parts: SQL[] = [sql`rc.org_id = ${orgId}`]
  if (allowedSubsidiaryIds !== null) parts.push(sql`and coalesce(rc.subsidiary_id,
    (select p.subsidiary_id from projects p where p.org_id=rc.org_id and p.id=rc.project_id),
    (select coalesce(dl.subsidiary_id,d.subsidiary_id) from performance_obligations o join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id join documents d on d.id=dl.document_id and d.org_id=dl.org_id where o.org_id=rc.org_id and o.contract_id=rc.id order by o.id limit 1))
      in (select jsonb_array_elements_text(${JSON.stringify([...(allowedSubsidiaryIds ?? [])])}::jsonb)::uuid)`)

  for (const filter of view.filters) {
    if (pushCustomFieldFilter(parts, filter, "rc")) continue
    const predicate = revenueContractFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and rc.status = ${adhoc.filters.status}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (rc.contract_number ilike ${query} or revenue_customer.display_name ilike ${query} or rc.memo ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
