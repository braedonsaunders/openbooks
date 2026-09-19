import { crmActivityScope } from '../../crm-scope'
import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { uuidOrFalse } from "../list-query";

/* ------------------------------------------------------------------ */
/* CRM activities                                                      */
/* ------------------------------------------------------------------ */

export const ACTIVITY_BASE_JOINS = sql`
  left join users u on u.id = a.assigned_user_id
  left join lateral (
    select p.id, p.display_name as name
      from crm_activity_links l join parties p on p.id = l.subject_id and p.org_id = l.org_id
     where l.activity_id = a.id and l.subject_kind = 'account' and l.org_id = a.org_id
     order by p.display_name limit 1
  ) customer on true`

const ACTIVITY_DATE_EXPR = sql`coalesce(a.starts_at, a.due_at, a.created_at)`

export const ACTIVITY_BUILT_IN_EXPR: Record<string, SQL> = {
  subject: sql`a.subject`,
  customer_name: sql`customer.name`,
  kind: sql`a.kind`,
  status: sql`a.status`,
  assigned_name: sql`u.name`,
  activity_date: sql`to_char(${ACTIVITY_DATE_EXPR}, 'YYYY-MM-DD HH24:MI')`,
  priority: sql`a.priority`,
}

export const ACTIVITY_SORTS: Record<string, SQL> = {
  subject: sql`a.subject`,
  customer: sql`customer.name`,
  date: ACTIVITY_DATE_EXPR,
  type: sql`a.kind`,
  status: sql`a.status`,
  owner: sql`u.name`,
}

function activityFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const select = (column: SQL) => {
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'ne') return sql`${column} <> ${value}`
    if (clause.operator === 'in' || clause.operator === 'not_in') {
      const values = (Array.isArray(clause.value) ? clause.value : [value]).map(String).filter(Boolean)
      if (!values.length) return clause.operator === 'in' ? sql`false` : sql`true`
      const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
      return clause.operator === 'in' ? sql`${column} in (${list})` : sql`${column} not in (${list})`
    }
    return null
  }
  if (clause.key === 'kind') return select(sql`a.kind`)
  if (clause.key === 'status') return select(sql`a.status`)
  if (clause.key === 'priority') return select(sql`a.priority`)
  if (clause.key === 'assigned_user_id') {
    const refused = uuidOrFalse(value)
    if (refused) return refused
    if (clause.operator === 'eq') return sql`a.assigned_user_id = ${value}`
    if (clause.operator === 'ne') return sql`a.assigned_user_id <> ${value}`
  }
  return null
}

export function activityWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string, allowed?: ReadonlySet<string> | null): SQL {
  const parts: SQL[] = [sql`a.org_id = ${orgId}`,crmActivityScope(allowed)]
  for (const filter of view.filters) {
    const predicate = activityFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.kind) parts.push(sql`and a.kind = ${adhoc.filters.kind}`)
  if (adhoc.filters?.status) parts.push(sql`and a.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.assigned_user_id) {
    const refused = uuidOrFalse(adhoc.filters.assigned_user_id)
    parts.push(refused ? sql`and ${refused}` : sql`and a.assigned_user_id = ${adhoc.filters.assigned_user_id}`)
  }
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (a.subject ilike ${query} or a.body ilike ${query} or customer.name ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
