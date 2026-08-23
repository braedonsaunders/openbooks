import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Opportunities                                                       */
/* ------------------------------------------------------------------ */

export const OPPORTUNITY_BASE_JOINS = sql`
  join crm_opportunity_statuses s on s.id = o.status_id and s.org_id = o.org_id
  left join parties p on p.id = o.party_id and p.org_id = o.org_id
  left join users u on u.id = o.owner_user_id`

export const OPPORTUNITY_BUILT_IN_EXPR: Record<string, SQL> = {
  opportunity_number: sql`o.opportunity_number`,
  title: sql`o.title`,
  account_name: sql`p.display_name`,
  status: sql`s.name`,
  owner_name: sql`u.name`,
  expected_close_date: sql`o.expected_close_date`,
  projected_amount: sql`o.projected_amount`,
  forecast_category: sql`o.forecast_category`,
  probability: sql`o.probability`,
  weighted_amount: sql`o.weighted_amount`,
}

export const OPPORTUNITY_SORTS: Record<string, SQL> = {
  number: sql`o.opportunity_number`,
  title: sql`o.title`,
  account: sql`p.display_name`,
  status: sql`s.sequence`,
  owner: sql`u.name`,
  close: sql`o.expected_close_date`,
  amount: sql`o.projected_amount`,
  category: sql`o.forecast_category`,
  probability: sql`o.probability`,
  weighted: sql`o.weighted_amount`,
}

const opportunitySingle = (value: unknown) =>
  Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')

function opportunityFilterPredicate(clause: FilterClause): SQL | null {
  const { key, operator, value } = clause
  const inList = (col: SQL): SQL | null => {
    const values = (Array.isArray(value) ? value : [String(value ?? '')]).map(String).filter(Boolean)
    if (values.length === 0) return operator === 'in' ? sql`false` : sql`true`
    const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
    return operator === 'in' ? sql`${col} in (${list})` : sql`${col} not in (${list})`
  }
  const ref = (col: SQL): SQL | null => {
    if (operator === 'eq') return sql`${col} = ${opportunitySingle(value)}`
    if (operator === 'ne') return sql`${col} <> ${opportunitySingle(value)}`
    return null
  }
  const select = (col: SQL): SQL | null => {
    if (operator === 'eq') return sql`${col} = ${opportunitySingle(value)}`
    if (operator === 'ne') return sql`${col} <> ${opportunitySingle(value)}`
    if (operator === 'in' || operator === 'not_in') return inList(col)
    return null
  }
  switch (key) {
    case 'status_id': return ref(sql`o.status_id`)
    case 'owner_user_id': return ref(sql`o.owner_user_id`)
    case 'party_id': return ref(sql`o.party_id`)
    case 'forecast_category': return select(sql`o.forecast_category`)
    case 'expected_close_date':
      if (operator === 'eq') return sql`o.expected_close_date = ${opportunitySingle(value)}`
      if (operator === 'gte') return sql`o.expected_close_date >= ${opportunitySingle(value)}`
      if (operator === 'lte') return sql`o.expected_close_date <= ${opportunitySingle(value)}`
      if (operator === 'between') return sql`o.expected_close_date between ${opportunitySingle(value)} and ${opportunitySingle(clause.to)}`
      return null
    case 'title':
      if (operator === 'eq') return sql`o.title = ${opportunitySingle(value)}`
      if (operator === 'contains') return sql`o.title ilike ${`%${opportunitySingle(value)}%`}`
      if (operator === 'is_set') return sql`o.title <> ''`
      if (operator === 'is_not_set') return sql`o.title = ''`
      return null
    default: return null
  }
}

export function opportunityWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`o.org_id = ${orgId}`]
  if (!adhoc.showInactive) parts.push(sql`and o.is_active`)
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and (o.subsidiary_id is null or o.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = opportunityFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  const quick = adhoc.filters ?? {}
  if (quick.status_id) parts.push(sql`and o.status_id = ${quick.status_id}`)
  if (quick.owner_user_id) parts.push(sql`and o.owner_user_id = ${quick.owner_user_id}`)
  if (quick.forecast_category) parts.push(sql`and o.forecast_category = ${quick.forecast_category}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (o.title ilike ${query} or o.opportunity_number ilike ${query} or p.display_name ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}
