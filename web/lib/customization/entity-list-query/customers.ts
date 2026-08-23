import "server-only";
import { sql, type SQL } from "drizzle-orm";
import type { ListViewConfig, FilterClause } from "@openbooks/customization";
import type { EntityAdhoc } from "./adhoc";

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

const CUSTOMER_ROLE_JOINS = sql`
  join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id and cr.is_active`

/** Customer role plus optional CRM lifecycle join for the canonical party row. */
export function customerBaseJoins(crmOn: boolean): SQL {
  if (!crmOn) return CUSTOMER_ROLE_JOINS
  return sql`${CUSTOMER_ROLE_JOINS}
  left join crm_account_profiles cap on cap.party_id = p.id and cap.org_id = p.org_id and cap.is_active`
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
  return {
    display_name: sql`p.display_name`,
    short_code: sql`p.short_code`,
    email: sql`p.email`,
    phone: sql`p.phone`,
    status,
  }
}

export const CUSTOMER_BUILT_IN_EXPR = customerBuiltInExpr(true)

export function customerSorts(crmOn: boolean): Record<string, SQL> {
  const status = customerStatusExpr(crmOn)
  return {
    name: sql`p.display_name`,
    code: sql`p.short_code`,
    status,
  }
}

export const CUSTOMER_SORTS = customerSorts(true)

function customerFilterPredicate(clause: FilterClause, statusExpr: SQL): SQL | null {
  const { key, operator } = clause
  const value = clause.value
  const single = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''))
  const inList = (col: SQL): SQL | null => {
    const values = (Array.isArray(value) ? value : [String(value ?? '')]).map(String)
    if (values.length === 0) return operator === 'in' ? sql`false` : sql`true`
    const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
    return operator === 'in' ? sql`${col} in (${list})` : sql`${col} not in (${list})`
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
  const statusExpr = customerStatusExpr(crmOn)
  for (const filter of view.filters) {
    const predicate = customerFilterPredicate(filter, statusExpr)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) {
    if (!crmOn && adhoc.filters.status !== 'customer') {
      parts.push(sql`and false`)
    } else {
      parts.push(sql`and ${statusExpr} = ${adhoc.filters.status}`)
    }
  }
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (p.display_name ilike ${query} or p.short_code ilike ${query} or p.email ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

function rolePartyWhere(
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

export const employeeWhere = (
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
) => rolePartyWhere('employee', view, adhoc, orgId, allowedSubsidiaryIds)
