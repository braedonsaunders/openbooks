import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

/** Posted actual cost per project (expense/cogs journal lines), lateral-joined. */
export const PROJECT_BASE_JOINS = sql`
  left join parties cust on cust.id = p.customer_id and cust.org_id = p.org_id
  left join lateral (
    select coalesce(sum(l.amount), 0) as cost
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = p.org_id and l.project_id = p.id and e.status = 'posted'
       and a.type in ('expense', 'cogs', 'expense_other', 'expense_deferred')
  ) actual on true`

const CONTRACT_EXPR = sql`p.contract_value`

/** Built-in column key → select expression for the projects list. */
export const PROJECT_BUILT_IN_EXPR: Record<string, SQL> = {
  code: sql`p.code`,
  name: sql`p.name`,
  customer: sql`cust.display_name`,
  status: sql`p.status`,
  project_type: sql`coalesce((select pt.key from project_types pt where pt.id = p.project_type_id and pt.org_id = p.org_id), 'time_and_materials')`,
  contract: CONTRACT_EXPR,
  actual: sql`actual.cost`,
  created: sql`to_char(p.created_at, 'YYYY-MM-DD')`,
}

/** Sort key → ORDER BY expression for the projects list. */
export const PROJECT_SORTS: Record<string, SQL> = {
  code: sql`p.code`,
  name: sql`p.name`,
  customer: sql`cust.display_name`,
  status: sql`p.status`,
  contract: CONTRACT_EXPR,
  actual: sql`actual.cost`,
  created: sql`p.created_at`,
}

function projectFilterPredicate(clause: FilterClause): SQL | null {
  const { key, operator } = clause
  const value = clause.value
  const single = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? ""))
  const inList = (col: SQL): SQL | null => {
    const values = (Array.isArray(value) ? value : [String(value ?? "")]).map(String)
    if (values.length === 0) return operator === "in" ? sql`false` : sql`true`
    const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
    return operator === "in" ? sql`${col} in (${list})` : sql`${col} not in (${list})`
  }
  switch (key) {
    case "status":
      if (operator === "eq") return sql`p.status = ${single(value)}`
      if (operator === "ne") return sql`p.status <> ${single(value)}`
      if (operator === "in" || operator === "not_in") return inList(sql`p.status`)
      return null
    case "project_type": {
      const typeExpr = sql`coalesce((select pt.key from project_types pt where pt.id = p.project_type_id and pt.org_id = p.org_id), 'time_and_materials')`
      if (operator === "eq") return sql`${typeExpr} = ${single(value)}`
      if (operator === "ne") return sql`${typeExpr} <> ${single(value)}`
      if (operator === "in" || operator === "not_in") return inList(typeExpr)
      return null
    }
    case "customer_id":
      if (operator === "eq") return sql`p.customer_id = ${single(value)}`
      if (operator === "ne") return sql`p.customer_id <> ${single(value)}`
      return null
    default:
      return null
  }
}

/**
 * The canonical WHERE fragment for the projects list: tenant scope, the saved
 * view's structured filters, the ad-hoc toolbar filters, and the active flag
 * (unless showInactive). `orgId` is mandatory — every query is tenant-scoped.
 */
export function projectWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`p.org_id = ${orgId}`]
  if (!adhoc.showInactive) parts.push(sql`and p.is_active`)
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and p.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])` : sql`and false`)
  }
  for (const f of view.filters) {
    const p = projectFilterPredicate(f)
    if (p) parts.push(sql`and ${p}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and p.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.project_type) parts.push(sql`and coalesce((select pt.key from project_types pt where pt.id = p.project_type_id and pt.org_id = p.org_id), 'time_and_materials') = ${adhoc.filters.project_type}`)
  if (adhoc.q)
    parts.push(
      sql`and (p.name ilike ${"%" + adhoc.q + "%"} or p.code ilike ${"%" + adhoc.q + "%"} or cust.display_name ilike ${"%" + adhoc.q + "%"})`,
    )
  return sql.join(parts, sql` `)
}
