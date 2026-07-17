import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";

/**
 * Entity list query helpers — the non-`documents` half of the universal list.
 * Mirrors list-query.ts (which is documents-shaped) for plain entity tables
 * such as `projects`. Same contract: whitelisted column→SQL expressions,
 * whitelisted filter→SQL predicates, all parameterized (identifiers are
 * code-controlled catalog keys, never user input).
 */

/** Ad-hoc URL/toolbar filters shared by entity lists. */
export interface EntityAdhoc {
  q?: string
  status?: string
  billing?: string
  showInactive?: boolean
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

/** Posted actual cost per project (expense/cogs journal lines), lateral-joined. */
export const PROJECT_BASE_JOINS = sql`
  left join parties cust on cust.id = p.customer_id
  left join lateral (
    select coalesce(sum(l.amount), 0) as cost
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where l.org_id = p.org_id and l.project_id = p.id and e.status = 'posted'
       and a.type in ('expense', 'cogs', 'expense_other', 'expense_deferred')
  ) actual on true`

const CONTRACT_EXPR = sql`(p.custom->>'contractValue')::numeric`

/** Built-in column key → select expression for the projects list. */
export const PROJECT_BUILT_IN_EXPR: Record<string, SQL> = {
  code: sql`p.code`,
  name: sql`p.name`,
  customer: sql`cust.display_name`,
  status: sql`p.status`,
  billing_method: sql`p.billing_method`,
  contract: CONTRACT_EXPR,
  actual: sql`actual.cost`,
}

/** Sort key → ORDER BY expression for the projects list. */
export const PROJECT_SORTS: Record<string, SQL> = {
  code: sql`p.code`,
  name: sql`p.name`,
  customer: sql`cust.display_name`,
  status: sql`p.status`,
  contract: CONTRACT_EXPR,
  actual: sql`actual.cost`,
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
    case "billing_method":
      if (operator === "eq") return sql`p.billing_method = ${single(value)}`
      if (operator === "ne") return sql`p.billing_method <> ${single(value)}`
      if (operator === "in" || operator === "not_in") return inList(sql`p.billing_method`)
      return null
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
  if (adhoc.status) parts.push(sql`and p.status = ${adhoc.status}`)
  if (adhoc.billing) parts.push(sql`and p.billing_method = ${adhoc.billing}`)
  if (adhoc.q)
    parts.push(
      sql`and (p.name ilike ${"%" + adhoc.q + "%"} or p.code ilike ${"%" + adhoc.q + "%"} or cust.display_name ilike ${"%" + adhoc.q + "%"})`,
    )
  return sql.join(parts, sql` `)
}
