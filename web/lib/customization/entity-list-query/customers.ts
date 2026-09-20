import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";
import { uuidOrFalse } from "../list-query";

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

const CUSTOMER_ROLE_JOINS = sql`
  join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id and cr.is_active`

/**
 * The ONE account surface.
 *
 * CRM off, the list is exactly the AR customer roll: an inner join on the
 * customer role, nothing else.
 *
 * CRM on, it is every account across the relationship lifecycle, so BOTH
 * sides become optional and `customerWhere` demands at least one of them. A
 * lead or prospect has a crm_account_profiles row and no customer role (the
 * role is written only on promotion — see promoteCrmAccount), so the old
 * inner join is precisely what kept them off this list and forced the
 * separate /crm/leads and /crm/prospects pages into being.
 */
export function customerBaseJoins(crmOn: boolean): SQL {
  if (!crmOn) return CUSTOMER_ROLE_JOINS
  return sql`
  left join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id and cr.is_active
  left join crm_account_profiles cap on cap.party_id = p.id and cap.org_id = p.org_id and cap.is_active
  left join crm_account_statuses cas on cas.id = cap.status_id and cas.org_id = cap.org_id
  left join users cap_owner on cap_owner.id = cap.owner_user_id
  left join crm_sales_territories cap_territory on cap_territory.id = cap.territory_id and cap_territory.org_id = cap.org_id`
}

/** CRM-on lists expose stored lifecycle stages; CRM-off lists treat every customer as existing. */
export function customerStatusExpr(crmOn: boolean): SQL {
  return crmOn ? sql`coalesce(cap.lifecycle_stage, 'customer')` : sql`'customer'`
}

/** Default joins when CRM is on — entity-list-view overrides when the switch is off. */
export const CUSTOMER_BASE_JOINS = customerBaseJoins(true)

export const CUSTOMER_STATUS_EXPR = customerStatusExpr(true)

export const PARTY_ACTIVE_STATUS_EXPR = sql`case when p.is_active then 'active' else 'inactive' end`

export const PARTY_BUILT_IN_EXPR: Record<string, SQL> = {
  display_name: sql`p.display_name`,
  short_code: sql`p.short_code`,
  email: sql`p.email`,
  phone: sql`p.phone`,
  status: PARTY_ACTIVE_STATUS_EXPR,
}

export const PARTY_SORTS: Record<string, SQL> = {
  name: sql`p.display_name`,
  code: sql`p.short_code`,
}

export function customerBuiltInExpr(crmOn: boolean): Record<string, SQL> {
  const status = customerStatusExpr(crmOn)
  const base = {
    display_name: sql`p.display_name`,
    short_code: sql`p.short_code`,
    email: sql`p.email`,
    phone: sql`p.phone`,
    status,
  }
  // The CRM columns read the crm_account_profiles joins, which only exist
  // when CRM is on; recordTypeForFeatureState drops the columns themselves in
  // the off case, so nothing can select an expression the FROM can't resolve.
  if (!crmOn) return base
  return {
    ...base,
    crm_status: sql`cas.name`,
    owner_name: sql`cap_owner.name`,
    territory_name: sql`cap_territory.name`,
    qualification_score: sql`cap.qualification_score`,
    last_activity: sql`to_char(cap.last_activity_at, 'YYYY-MM-DD')`,
  }
}

export const CUSTOMER_BUILT_IN_EXPR = customerBuiltInExpr(true)

export function customerSorts(crmOn: boolean): Record<string, SQL> {
  const status = customerStatusExpr(crmOn)
  const base = {
    name: sql`p.display_name`,
    code: sql`p.short_code`,
    status,
  }
  if (!crmOn) return base
  return {
    ...base,
    crm_status: sql`cas.sequence`,
    owner: sql`cap_owner.name`,
    territory: sql`cap_territory.name`,
    score: sql`cap.qualification_score`,
    activity: sql`cap.last_activity_at`,
  }
}

export const CUSTOMER_SORTS = customerSorts(true)

/** CRM profile columns a saved view may filter on, once CRM is on. */
const CUSTOMER_CRM_FILTER_COLUMNS: Record<string, SQL> = {
  status_id: sql`cap.status_id`,
  owner_user_id: sql`cap.owner_user_id`,
  territory_id: sql`cap.territory_id`,
}

function customerFilterPredicate(clause: FilterClause, statusExpr: SQL, crmOn: boolean): SQL | null {
  const { key, operator } = clause
  const value = clause.value
  const single = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''))
  const inList = (col: SQL): SQL | null => {
    const values = (Array.isArray(value) ? value : [String(value ?? '')]).map(String)
    if (values.length === 0) return operator === 'in' ? sql`false` : sql`true`
    const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
    return operator === 'in' ? sql`${col} in (${list})` : sql`${col} not in (${list})`
  }

  const crmColumn = CUSTOMER_CRM_FILTER_COLUMNS[key]
  if (crmColumn) {
    // A stale saved view can still name a CRM filter after the switch goes
    // off; without the join there is nothing to compare, so it matches
    // nothing rather than erroring or silently widening the list.
    if (!crmOn) return sql`false`
    const refused = uuidOrFalse(single(value))
    if (refused) return refused
    if (operator === 'eq') return sql`${crmColumn} = ${single(value)}`
    if (operator === 'ne') return sql`${crmColumn} <> ${single(value)}`
    return null
  }

  if (key !== 'status') return null
  if (operator === 'eq') return sql`${statusExpr} = ${single(value)}`
  if (operator === 'ne') return sql`${statusExpr} <> ${single(value)}`
  if (operator === 'in' || operator === 'not_in') return inList(statusExpr)
  return null
}

/** Canonical customer-list scope. Importers enforce one party per source id. */
export function customerWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`p.org_id = ${orgId}`]
  if (!adhoc.showInactive) parts.push(sql`and p.is_active`)
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))` : sql`and false`)
  }
  const crmOn = adhoc.crmEnabled !== false
  // CRM on, both joins are outer: membership is "sells to us or we sell to
  // them" — an active customer role OR an active relationship profile. CRM
  // off, the inner role join already scopes the list.
  if (crmOn) parts.push(sql`and (cr.party_id is not null or cap.party_id is not null)`)
  const statusExpr = customerStatusExpr(crmOn)
  for (const filter of view.filters) {
    const predicate = customerFilterPredicate(filter, statusExpr, crmOn)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) {
    if (!crmOn && adhoc.filters.status !== 'customer') {
      parts.push(sql`and false`)
    } else {
      parts.push(sql`and ${statusExpr} = ${adhoc.filters.status}`)
    }
  }
  for (const [key, column] of Object.entries(CUSTOMER_CRM_FILTER_COLUMNS)) {
    const selected = adhoc.filters?.[key]
    if (!selected) continue
    if (!crmOn) { parts.push(sql`and false`); continue }
    const refused = uuidOrFalse(selected)
    parts.push(refused ? sql`and ${refused}` : sql`and ${column} = ${selected}`)
  }
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (p.display_name ilike ${query} or p.short_code ilike ${query} or p.email ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

export function rolePartyWhere(
  role: 'vendor' | 'employee',
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const roleTable = sql.raw(`${role}_roles`)
  const parts: SQL[] = [
    sql`p.org_id = ${orgId}`,
    sql`and exists (select 1 from ${roleTable} r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)`,
  ]
  if (!adhoc.showInactive) parts.push(sql`and p.is_active`)
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))` : sql`and false`)
  }
  void view
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (p.display_name ilike ${query} or p.short_code ilike ${query} or p.email ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

export const vendorWhere = (
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
) => rolePartyWhere('vendor', view, adhoc, orgId, allowedSubsidiaryIds)

/** Employee-list WHERE lives in ./employment-directory (HR-2b): the role base above plus the as-of directory predicates. */
