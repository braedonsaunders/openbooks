import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Bank reconciliations                                                */
/* ------------------------------------------------------------------ */

export const BANK_RECONCILIATION_BASE_JOINS = sql`
  join accounts bank_account on bank_account.id=r.account_id and bank_account.org_id=r.org_id`

export const BANK_RECONCILIATION_BUILT_IN_EXPR: Record<string, SQL> = {
  account_name: sql`concat_ws(' · ', bank_account.number, bank_account.name)`,
  through_date: sql`r.through_date`,
  statement_balance: sql`r.statement_balance`,
  status: sql`r.status`,
  started: sql`to_char(r.created_at, 'YYYY-MM-DD')`,
  signed_off: sql`to_char(r.signed_off_at, 'YYYY-MM-DD')`,
}

export const BANK_RECONCILIATION_SORTS: Record<string, SQL> = {
  account: sql`bank_account.number`,
  through: sql`r.through_date`,
  balance: sql`r.statement_balance`,
  status: sql`r.status`,
  created: sql`r.created_at`,
  signed_off: sql`r.signed_off_at`,
}

function bankReconciliationFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  if (clause.key === 'status') {
    if (clause.operator === 'eq') return sql`r.status = ${value}`
    if (clause.operator === 'ne') return sql`r.status <> ${value}`
    if (clause.operator === 'in' || clause.operator === 'not_in') {
      const values = (Array.isArray(clause.value) ? clause.value : [value]).map(String).filter(Boolean)
      if (!values.length) return clause.operator === 'in' ? sql`false` : sql`true`
      const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
      return clause.operator === 'in' ? sql`r.status in (${list})` : sql`r.status not in (${list})`
    }
  }
  if (clause.key === 'account_id') {
    if (clause.operator === 'eq') return sql`r.account_id = ${value}`
    if (clause.operator === 'ne') return sql`r.account_id <> ${value}`
  }
  if (clause.key === 'through_date') {
    if (clause.operator === 'eq') return sql`r.through_date = ${value}`
    if (clause.operator === 'gte') return sql`r.through_date >= ${value}`
    if (clause.operator === 'lte') return sql`r.through_date <= ${value}`
    if (clause.operator === 'between') return sql`r.through_date between ${value} and ${String(clause.to ?? '')}`
  }
  return null
}

export function bankReconciliationWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`r.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and (bank_account.subsidiary_id is null or bank_account.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = bankReconciliationFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and r.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.account_id) parts.push(sql`and r.account_id = ${adhoc.filters.account_id}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (r.through_date::text ilike ${query} or bank_account.number ilike ${query} or bank_account.name ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Imported bank statements                                           */
/* ------------------------------------------------------------------ */

export const BANK_STATEMENT_BASE_JOINS = sql`
  join accounts statement_account on statement_account.id=bs.account_id and statement_account.org_id=bs.org_id
  left join lateral (
    select count(*) as line_count,
           count(*) filter (where line.match_status='unmatched') as unmatched_count
      from bank_statement_lines line
     where line.statement_id=bs.id and line.org_id=bs.org_id
  ) statement_lines on true`

export const BANK_STATEMENT_BUILT_IN_EXPR: Record<string, SQL> = {
  statement_date: sql`bs.statement_date`,
  account_name: sql`concat_ws(' · ', statement_account.number, statement_account.name)`,
  source: sql`bs.source`,
  line_count: sql`coalesce(statement_lines.line_count, 0)::text`,
  unmatched_count: sql`coalesce(statement_lines.unmatched_count, 0)::text`,
  opening_balance: sql`bs.opening_balance`,
  closing_balance: sql`bs.closing_balance`,
  imported: sql`to_char(bs.imported_at, 'YYYY-MM-DD')`,
}

export const BANK_STATEMENT_SORTS: Record<string, SQL> = {
  date: sql`bs.statement_date`,
  account: sql`statement_account.number`,
  source: sql`bs.source`,
  lines: sql`coalesce(statement_lines.line_count, 0)`,
  unmatched: sql`coalesce(statement_lines.unmatched_count, 0)`,
  opening: sql`bs.opening_balance`,
  closing: sql`bs.closing_balance`,
  imported: sql`bs.imported_at`,
}

function bankStatementFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  if (clause.key === 'source') {
    if (clause.operator === 'eq') return sql`bs.source = ${value}`
    if (clause.operator === 'ne') return sql`bs.source <> ${value}`
    if (clause.operator === 'in' || clause.operator === 'not_in') {
      const values = (Array.isArray(clause.value) ? clause.value : [value]).map(String).filter(Boolean)
      if (!values.length) return clause.operator === 'in' ? sql`false` : sql`true`
      const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
      return clause.operator === 'in' ? sql`bs.source in (${list})` : sql`bs.source not in (${list})`
    }
  }
  if (clause.key === 'account_id') {
    if (clause.operator === 'eq') return sql`bs.account_id = ${value}`
    if (clause.operator === 'ne') return sql`bs.account_id <> ${value}`
  }
  if (clause.key === 'statement_date') {
    if (clause.operator === 'eq') return sql`bs.statement_date = ${value}`
    if (clause.operator === 'gte') return sql`bs.statement_date >= ${value}`
    if (clause.operator === 'lte') return sql`bs.statement_date <= ${value}`
    if (clause.operator === 'between') return sql`bs.statement_date between ${value} and ${String(clause.to ?? '')}`
  }
  return null
}

export function bankStatementWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`bs.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and (statement_account.subsidiary_id is null or statement_account.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = bankStatementFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.source) parts.push(sql`and bs.source = ${adhoc.filters.source}`)
  if (adhoc.filters?.account_id) parts.push(sql`and bs.account_id = ${adhoc.filters.account_id}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (bs.statement_date::text ilike ${query} or bs.source ilike ${query} or statement_account.number ilike ${query} or statement_account.name ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Bank matching rules                                                 */
/* ------------------------------------------------------------------ */

export const BANK_RULE_BUILT_IN_EXPR: Record<string, SQL> = {
  priority: sql`br.priority::text`,
  name: sql`br.name`,
  criteria_summary: sql`br.criteria`,
  outcome_summary: sql`br.outcome`,
  status: sql`case when br.is_active then 'active' else 'inactive' end`,
  created: sql`to_char(br.created_at, 'YYYY-MM-DD')`,
}

export const BANK_RULE_SORTS: Record<string, SQL> = {
  priority: sql`br.priority`,
  name: sql`br.name`,
  created: sql`br.created_at`,
}

export function bankRuleWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`br.org_id = ${orgId}`]
  for (const filter of view.filters) {
    if (filter.key !== 'is_active') continue
    const value = Array.isArray(filter.value) ? String(filter.value[0] ?? '') : String(filter.value ?? '')
    if (filter.operator === 'eq') parts.push(sql`and br.is_active = ${value === 'true'}`)
    else if (filter.operator === 'ne') parts.push(sql`and br.is_active <> ${value === 'true'}`)
  }
  if (adhoc.filters?.is_active) parts.push(sql`and br.is_active = ${adhoc.filters.is_active === 'true'}`)
  if (adhoc.q) parts.push(sql`and br.name ilike ${`%${adhoc.q}%`}`)
  return sql.join(parts, sql` `)
}
