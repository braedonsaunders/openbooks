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
  /** Quick-filter values keyed by the customization registry filter key. */
  filters?: Record<string, string | undefined>
  showInactive?: boolean
}

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

/** Customer role and CRM lifecycle data for the canonical party row. */
export const CUSTOMER_BASE_JOINS = sql`
  join customer_roles cr on cr.party_id = p.id and cr.is_active
  left join crm_account_profiles cap on cap.party_id = p.id and cap.is_active`

export const CUSTOMER_STATUS_EXPR = sql`coalesce(cap.lifecycle_stage, 'customer')`

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

export const CUSTOMER_BUILT_IN_EXPR: Record<string, SQL> = {
  display_name: sql`p.display_name`,
  short_code: sql`p.short_code`,
  email: sql`p.email`,
  phone: sql`p.phone`,
  status: CUSTOMER_STATUS_EXPR,
}

export const CUSTOMER_SORTS: Record<string, SQL> = {
  name: sql`p.display_name`,
  code: sql`p.short_code`,
  status: CUSTOMER_STATUS_EXPR,
}

function customerFilterPredicate(clause: FilterClause): SQL | null {
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
  if (operator === 'eq') return sql`${CUSTOMER_STATUS_EXPR} = ${single(value)}`
  if (operator === 'ne') return sql`${CUSTOMER_STATUS_EXPR} <> ${single(value)}`
  if (operator === 'in' || operator === 'not_in') return inList(CUSTOMER_STATUS_EXPR)
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
  for (const filter of view.filters) {
    const predicate = customerFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and ${CUSTOMER_STATUS_EXPR} = ${adhoc.filters.status}`)
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
    sql`and exists (select 1 from ${roleTable} r where r.party_id = p.id and r.is_active)`,
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

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

/** Posted actual cost per project (expense/cogs journal lines), lateral-joined. */
export const PROJECT_BASE_JOINS = sql`
  left join parties cust on cust.id = p.customer_id
  left join lateral (
    select coalesce(sum(l.amount), 0) as cost
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = p.org_id and l.project_id = p.id and e.status in ('posted', 'reversed')
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

/* ------------------------------------------------------------------ */
/* CRM leads and prospects                                             */
/* ------------------------------------------------------------------ */

export const CRM_ACCOUNT_BASE_JOINS = sql`
  join parties p on p.id = cp.party_id and p.org_id = cp.org_id
  left join crm_account_statuses s on s.id = cp.status_id and s.org_id = cp.org_id
  left join users u on u.id = cp.owner_user_id
  left join crm_sales_territories territory on territory.id = cp.territory_id`

export const CRM_ACCOUNT_BUILT_IN_EXPR: Record<string, SQL> = {
  account_name: sql`p.display_name`,
  status: sql`s.name`,
  owner_name: sql`u.name`,
  territory_name: sql`territory.name`,
  qualification_score: sql`cp.qualification_score`,
  last_activity: sql`to_char(cp.last_activity_at, 'YYYY-MM-DD')`,
  email: sql`p.email`,
  phone: sql`p.phone`,
}

export const CRM_ACCOUNT_SORTS: Record<string, SQL> = {
  name: sql`p.display_name`,
  status: sql`s.sequence`,
  owner: sql`u.name`,
  territory: sql`territory.name`,
  score: sql`cp.qualification_score`,
  activity: sql`cp.last_activity_at`,
}

function crmAccountFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const ref = (column: SQL) => {
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'ne') return sql`${column} <> ${value}`
    return null
  }
  if (clause.key === 'status_id') return ref(sql`cp.status_id`)
  if (clause.key === 'owner_user_id') return ref(sql`cp.owner_user_id`)
  if (clause.key === 'territory_id') return ref(sql`cp.territory_id`)
  return null
}

function crmAccountWhere(
  stage: 'lead' | 'prospect',
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`cp.org_id = ${orgId} and cp.lifecycle_stage = ${stage} and cp.is_active and p.is_active`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = crmAccountFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status_id) parts.push(sql`and cp.status_id = ${adhoc.filters.status_id}`)
  if (adhoc.filters?.owner_user_id) parts.push(sql`and cp.owner_user_id = ${adhoc.filters.owner_user_id}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (p.display_name ilike ${query} or p.email ilike ${query} or p.phone ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

export const leadWhere = (
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
) => crmAccountWhere('lead', view, adhoc, orgId, allowedSubsidiaryIds)

export const prospectWhere = (
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
) => crmAccountWhere('prospect', view, adhoc, orgId, allowedSubsidiaryIds)

/* ------------------------------------------------------------------ */
/* CRM activities                                                      */
/* ------------------------------------------------------------------ */

export const ACTIVITY_BASE_JOINS = sql`
  left join users u on u.id = a.assigned_user_id
  left join lateral (
    select p.id, p.display_name as name
      from crm_activity_links l join parties p on p.id = l.subject_id
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
    if (clause.operator === 'eq') return sql`a.assigned_user_id = ${value}`
    if (clause.operator === 'ne') return sql`a.assigned_user_id <> ${value}`
  }
  return null
}

export function activityWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`a.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const predicate = activityFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.kind) parts.push(sql`and a.kind = ${adhoc.filters.kind}`)
  if (adhoc.filters?.status) parts.push(sql`and a.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.assigned_user_id) parts.push(sql`and a.assigned_user_id = ${adhoc.filters.assigned_user_id}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (a.subject ilike ${query} or a.body ilike ${query} or customer.name ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

export const ITEM_STATUS_EXPR = sql`case when i.is_active then 'active' else 'inactive' end`

export const ITEM_BUILT_IN_EXPR: Record<string, SQL> = {
  code: sql`i.code`,
  name: sql`i.name`,
  kind: sql`i.kind`,
  category: sql`i.category`,
  default_rate: sql`i.default_rate`,
  default_cost: sql`i.default_cost`,
  unit: sql`i.unit`,
  status: ITEM_STATUS_EXPR,
}

export const ITEM_SORTS: Record<string, SQL> = {
  code: sql`i.code`,
  name: sql`i.name`,
  kind: sql`i.kind`,
  category: sql`i.category`,
  rate: sql`i.default_rate`,
  cost: sql`i.default_cost`,
  status: sql`i.is_active`,
}

function itemFilterPredicate(clause: FilterClause): SQL | null {
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
  if (clause.key === 'kind') return select(sql`i.kind`)
  if (clause.key === 'status') return select(ITEM_STATUS_EXPR)
  if (clause.key === 'category') {
    if (clause.operator === 'eq') return sql`i.category = ${value}`
    if (clause.operator === 'contains') return sql`i.category ilike ${`%${value}%`}`
    if (clause.operator === 'is_set') return sql`coalesce(i.category, '') <> ''`
    if (clause.operator === 'is_not_set') return sql`coalesce(i.category, '') = ''`
  }
  return null
}

export function itemWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`i.org_id = ${orgId}`]
  const savedViewOwnsActivity = view.filters.some((filter) => filter.key === 'status')
  if (!adhoc.showInactive && !savedViewOwnsActivity) parts.push(sql`and i.is_active`)
  for (const filter of view.filters) {
    const predicate = itemFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.kind) parts.push(sql`and i.kind = ${adhoc.filters.kind}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (i.name ilike ${query} or i.code ilike ${query} or i.category ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export const ACCOUNT_CLASS_EXPR = sql`case
  when a.type in ('asset_bank','asset_receivable','asset_current_other','asset_fixed','asset_other') then 'asset'
  when a.type in ('liability_payable','liability_card','liability_current_other','liability_long_term') then 'liability'
  when a.type = 'equity' then 'equity'
  when a.type in ('income','income_other') then 'income'
  else 'expense' end`

export const ACCOUNT_STATUS_EXPR = sql`case when a.is_active then 'active' else 'inactive' end`

/**
 * Each account's balance including its subtree. Months before the current one
 * come from the gl_month_activity summary and only the current month is read
 * from journal_lines — a fiscal-year start is always the first of a month, so
 * the as-of date is the only boundary that can split one. The previous form
 * ran a recursive descendant roll-up over the raw lines once per listed
 * account, which scanned the ledger dozens of times per page.
 */
export function accountBaseJoins(today: string): SQL {
  return sql`
  left join accounts parent on parent.id = a.parent_id
  left join lateral (
    with recursive descendants(id) as (
      select a.id
      union all
      select child.id
        from accounts child
        join descendants tree on child.parent_id = tree.id
       where child.org_id = a.org_id
    ),
    fy as (
      select make_date(
        case when extract(month from ${today}::date) >= 4 then extract(year from ${today}::date)::int else extract(year from ${today}::date)::int - 1 end,
        4, 1) as starts_on
    ),
    movement as (
      select (g.debit_total - g.credit_total) as amt, g.month as d
        from gl_month_activity g
        join descendants tree on tree.id = g.account_id
       where g.org_id = a.org_id and g.month < date_trunc('month', ${today}::date)::date
      union all
      select l.amount, e.posting_date
        from journal_lines l
        join descendants tree on tree.id = l.account_id
        join journal_entries e on e.id = l.entry_id and e.org_id = a.org_id
         and e.status in ('posted', 'reversed')
         and e.posting_date >= date_trunc('month', ${today}::date)::date
         and e.posting_date <= ${today}::date
       where l.org_id = a.org_id
    )
    select coalesce(sum(m.amt), 0)
           * case when a.type in ('income','income_other','liability_payable','liability_card','liability_current_other','liability_long_term','equity') then -1 else 1 end as amount
      from movement m, fy
     where a.type not in ('income','income_other','cogs','expense','expense_other','expense_deferred')
        or m.d >= fy.starts_on
  ) account_balance on true`
}

export const ACCOUNT_BUILT_IN_EXPR: Record<string, SQL> = {
  number: sql`a.number`,
  name: sql`a.name`,
  type: sql`a.type`,
  class: ACCOUNT_CLASS_EXPR,
  parent_name: sql`parent.name`,
  balance: sql`account_balance.amount`,
  is_summary: sql`case when a.is_summary then 'Yes' else 'No' end`,
  status: ACCOUNT_STATUS_EXPR,
}

export const ACCOUNT_SORTS: Record<string, SQL> = {
  number: sql`a.number`,
  name: sql`a.name`,
  type: sql`a.type`,
  class: ACCOUNT_CLASS_EXPR,
  parent: sql`parent.name`,
  balance: sql`account_balance.amount`,
  status: sql`a.is_active`,
}

function accountFilterPredicate(clause: FilterClause): SQL | null {
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
  if (clause.key === 'class') return select(ACCOUNT_CLASS_EXPR)
  if (clause.key === 'type') return select(sql`a.type`)
  if (clause.key === 'status') return select(ACCOUNT_STATUS_EXPR)
  if (clause.key === 'parent_id') {
    if (clause.operator === 'eq') return sql`a.parent_id = ${value}`
    if (clause.operator === 'ne') return sql`a.parent_id <> ${value}`
  }
  return null
}

export function accountWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`a.org_id = ${orgId}`]
  const savedViewOwnsActivity = view.filters.some((filter) => filter.key === 'status')
  if (!adhoc.showInactive && !savedViewOwnsActivity) parts.push(sql`and a.is_active`)
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and (a.subsidiary_id is null or a.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = accountFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.class) parts.push(sql`and ${ACCOUNT_CLASS_EXPR} = ${adhoc.filters.class}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (a.name ilike ${query} or a.number ilike ${query} or a.description ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Journal entries                                                     */
/* ------------------------------------------------------------------ */

export const JOURNAL_ENTRY_BUILT_IN_EXPR: Record<string, SQL> = {
  posting_date: sql`e.posting_date`,
  entry_number: sql`e.entry_number`,
  memo: sql`e.memo`,
  origin: sql`e.origin`,
  line_count: sql`entry_totals.line_count`,
  total_debits: sql`entry_totals.total_debits`,
  status: sql`e.status`,
}

export const JOURNAL_ENTRY_SORTS: Record<string, SQL> = {
  date: sql`e.posting_date`,
  number: sql`e.entry_number`,
  origin: sql`e.origin`,
  lines: sql`entry_totals.line_count`,
  debits: sql`entry_totals.total_debits`,
  status: sql`e.status`,
}

/**
 * The journal list's backing relation: entries visible in the journal are the
 * union of (a) standalone engine journals by origin and (b) entries posted by
 * a journal-kind document. Both legs are index-driven ((org_id, origin,
 * posting_date) and documents (org_id, kind) → posted_entry_id); the outer
 * org_id predicate pushes down into each. UNION (not ALL) dedupes an entry
 * that qualifies both ways.
 */
export const JOURNAL_ENTRY_TABLE = `(
  select je.* from journal_entries je
   where je.origin in ('manual','closing','allocation','revaluation','labor_burden','depreciation','revenue_recognition','fx_settlement','translation')
  union
  select je.* from journal_entries je
    join documents jd on jd.posted_entry_id = je.id and jd.kind = 'journal' and jd.org_id = je.org_id
)`

/** The one join the journal-entry WHERE clause references (manual-vs-document
 * visibility). Count queries use exactly this — the per-entry line totals
 * below would otherwise be computed for EVERY entry in the tenant just to
 * produce a count. */
export function journalEntryCountJoins(): SQL {
  return sql`
    left join lateral (
      select d.id, d.custom
        from documents d
       where d.posted_entry_id = e.id and d.kind = 'journal'
       limit 1
    ) source_doc on true`
}

export function journalEntryBaseJoins(allowedSubsidiaryIds?: Set<string> | null): SQL {
  const ids = allowedSubsidiaryIds ? [...allowedSubsidiaryIds] : []
  const lineVisibility = allowedSubsidiaryIds
    ? ids.length
      ? sql`and l.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])`
      : sql`and false`
    : sql``
  return sql`
    ${journalEntryCountJoins()}
    join lateral (
      select count(l.id) as line_count,
             coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as total_debits
        from journal_lines l
       where l.entry_id = e.id ${lineVisibility}
    ) entry_totals on true`
}

function journalEntryFilterPredicate(clause: FilterClause): SQL | null {
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
  if (clause.key === 'origin') return select(sql`e.origin`)
  if (clause.key === 'status') return select(sql`e.status`)
  if (clause.key === 'posting_date') {
    if (clause.operator === 'eq') return sql`e.posting_date = ${value}`
    if (clause.operator === 'gte') return sql`e.posting_date >= ${value}`
    if (clause.operator === 'lte') return sql`e.posting_date <= ${value}`
    if (clause.operator === 'between') return sql`e.posting_date between ${value} and ${String(clause.to ?? '')}`
  }
  return null
}

export function journalEntryWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  // Visibility (journal-document entries plus standalone engine journals) is
  // built into JOURNAL_ENTRY_TABLE as a union of two index-driven legs — a
  // WHERE-level OR here defeated the ORDER BY/LIMIT index walk and the old
  // per-row source_doc lateral test ran for every entry in the tenant.
  const parts: SQL[] = [sql`e.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and exists (
      select 1 from journal_lines visible
       where visible.entry_id=e.id and visible.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])
    )` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = journalEntryFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.origin) parts.push(sql`and e.origin = ${adhoc.filters.origin}`)
  if (adhoc.filters?.status) parts.push(sql`and e.status = ${adhoc.filters.status}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (e.entry_number ilike ${query} or e.memo ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

export const INVENTORY_ONHAND_BUILT_IN_EXPR: Record<string, SQL> = {
  item_name: sql`concat_ws(' · ', it.code, it.name)`,
  location_code: sql`sl.code`,
  quantity: sql`round(oh.quantity, 4)::text`,
  average_cost: sql`case when oh.quantity <> 0 then oh.value / oh.quantity else 0 end`,
  value: sql`oh.value`,
}

export const INVENTORY_ONHAND_SORTS: Record<string, SQL> = {
  item: sql`it.name`,
  location: sql`sl.code`,
  quantity: sql`oh.quantity`,
  average_cost: sql`case when oh.quantity <> 0 then oh.value / oh.quantity else 0 end`,
  value: sql`oh.value`,
}

function inventoryRefFilter(clause: FilterClause, itemColumn: SQL, locationColumn: SQL): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const column = clause.key === 'item_id' ? itemColumn : clause.key === 'stock_location_id' ? locationColumn : null
  if (!column) return null
  if (clause.operator === 'eq') return sql`${column} = ${value}`
  if (clause.operator === 'ne') return sql`${column} <> ${value}`
  return null
}

export function inventoryOnhandWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`oh.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const predicate = inventoryRefFilter(filter, sql`oh.item_id`, sql`oh.stock_location_id`)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (it.name ilike ${query} or it.code ilike ${query} or sl.code ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

export const INVENTORY_MOVEMENT_BASE_JOINS = sql`
  join items it on it.id = m.item_id and it.org_id = m.org_id
  join stock_locations sl on sl.id = m.stock_location_id and sl.org_id = m.org_id`

export const INVENTORY_MOVEMENT_BUILT_IN_EXPR: Record<string, SQL> = {
  movement_date: sql`to_char(m.moved_at, 'YYYY-MM-DD')`,
  kind: sql`m.kind`,
  item_name: sql`concat_ws(' · ', it.code, it.name)`,
  location_code: sql`sl.code`,
  quantity: sql`round(m.quantity, 4)::text`,
  unit_cost: sql`m.unit_cost`,
  total_value: sql`m.total_value`,
  status: sql`m.status`,
  memo: sql`m.memo`,
}

export const INVENTORY_MOVEMENT_SORTS: Record<string, SQL> = {
  date: sql`m.moved_at`,
  kind: sql`m.kind`,
  item: sql`it.name`,
  location: sql`sl.code`,
  quantity: sql`m.quantity`,
  unit_cost: sql`m.unit_cost`,
  value: sql`m.total_value`,
  status: sql`m.status`,
}

export function inventoryMovementWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`m.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const ref = inventoryRefFilter(filter, sql`m.item_id`, sql`m.stock_location_id`)
    if (ref) {
      parts.push(sql`and ${ref}`)
      continue
    }
    const value = Array.isArray(filter.value) ? String(filter.value[0] ?? '') : String(filter.value ?? '')
    if (filter.key === 'kind') {
      if (filter.operator === 'eq') parts.push(sql`and m.kind = ${value}`)
      else if (filter.operator === 'ne') parts.push(sql`and m.kind <> ${value}`)
    } else if (filter.key === 'moved_at') {
      if (filter.operator === 'eq') parts.push(sql`and m.moved_at::date = ${value}`)
      else if (filter.operator === 'gte') parts.push(sql`and m.moved_at::date >= ${value}`)
      else if (filter.operator === 'lte') parts.push(sql`and m.moved_at::date <= ${value}`)
      else if (filter.operator === 'between') parts.push(sql`and m.moved_at::date between ${value} and ${String(filter.to ?? '')}`)
    }
  }
  if (adhoc.filters?.kind) parts.push(sql`and m.kind = ${adhoc.filters.kind}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (it.name ilike ${query} or it.code ilike ${query} or sl.code ilike ${query} or m.memo ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

export const BUDGET_BASE_JOINS = sql`
  join accounting_books budget_book on budget_book.id=bs.book_id and budget_book.org_id=bs.org_id
  left join lateral (
    select coalesce(sum(case when a.type in ('income','income_other') then -bl.amount else bl.amount end), 0) as amount
      from budget_lines bl
      left join accounts a on a.id=bl.account_id and a.org_id=bl.org_id
     where bl.scenario_id=bs.id and bl.org_id=bs.org_id
  ) budget_total on true`

export const BUDGET_BUILT_IN_EXPR: Record<string, SQL> = {
  name: sql`bs.name`,
  book_name: sql`budget_book.name`,
  fiscal_year: sql`bs.fiscal_year::text`,
  kind: sql`bs.kind`,
  status: sql`bs.status`,
  total_amount: sql`budget_total.amount`,
  updated: sql`to_char(bs.updated_at, 'YYYY-MM-DD HH24:MI')`,
}

export const BUDGET_SORTS: Record<string, SQL> = {
  name: sql`bs.name`,
  book: sql`budget_book.name`,
  year: sql`bs.fiscal_year`,
  kind: sql`bs.kind`,
  status: sql`bs.status`,
  total: sql`budget_total.amount`,
  updated: sql`bs.updated_at`,
}

function budgetFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const select = (column: SQL) => {
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'ne') return sql`${column} <> ${value}`
    if (clause.operator === 'in' || clause.operator === 'not_in') {
      const values = (Array.isArray(clause.value) ? clause.value : [value]).map(String).filter(Boolean)
      if (!values.length) return clause.operator === 'in' ? sql`false` : sql`true`
      const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
      return clause.operator === 'in' ? sql`${column}::text in (${list})` : sql`${column}::text not in (${list})`
    }
    return null
  }
  if (clause.key === 'status') return select(sql`bs.status`)
  if (clause.key === 'kind') return select(sql`bs.kind`)
  if (clause.key === 'fiscal_year') return select(sql`bs.fiscal_year`)
  if (clause.key === 'book_id') {
    if (clause.operator === 'eq') return sql`bs.book_id = ${value}`
    if (clause.operator === 'ne') return sql`bs.book_id <> ${value}`
  }
  return null
}

export function budgetWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`bs.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const predicate = budgetFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and bs.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.kind) parts.push(sql`and bs.kind = ${adhoc.filters.kind}`)
  if (adhoc.filters?.fiscal_year) parts.push(sql`and bs.fiscal_year = ${adhoc.filters.fiscal_year}`)
  if (adhoc.filters?.book_id) parts.push(sql`and bs.book_id = ${adhoc.filters.book_id}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (bs.name ilike ${query} or bs.description ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Revenue contracts                                                   */
/* ------------------------------------------------------------------ */

export const REVENUE_CONTRACT_BASE_JOINS = sql`
  left join parties revenue_customer on revenue_customer.id=rc.customer_id
  left join lateral (
    select coalesce(sum(l.planned_amount), 0) as planned,
           coalesce(sum(l.recognized_amount) filter (where l.journal_entry_id is not null), 0) as recognized
      from performance_obligations o
      join recognition_schedules s on s.obligation_id=o.id
      join accounting_books bk on bk.id=s.book_id and bk.is_primary
      join recognition_schedule_lines l on l.schedule_id=s.id
     where o.contract_id=rc.id
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
    if (clause.operator === 'eq') return sql`rc.customer_id = ${value}`
    if (clause.operator === 'ne') return sql`rc.customer_id <> ${value}`
  }
  if (clause.key === 'starts_on' || clause.key === 'ends_on') {
    const column = clause.key === 'starts_on' ? sql`rc.starts_on` : sql`rc.ends_on`
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'gte') return sql`${column} >= ${value}`
    if (clause.operator === 'lte') return sql`${column} <= ${value}`
    if (clause.operator === 'between') return sql`${column} between ${value} and ${String(clause.to ?? '')}`
  }
  return null
}

export function revenueContractWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`rc.org_id = ${orgId}`]
  for (const filter of view.filters) {
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

/* ------------------------------------------------------------------ */
/* Equipment units                                                     */
/* ------------------------------------------------------------------ */

export const EQUIPMENT_BASE_JOINS = sql`
  left join items equipment_item on equipment_item.id=eu.charge_item_id
  left join lateral (
    select coalesce(sum(dl.cost_amount) filter (where d.status in ('approved','posted')), 0) as recovery,
           coalesce(sum(dl.bill_amount) filter (where d.status in ('approved','posted')), 0) as billable
      from document_lines dl
      join documents d on d.id=dl.document_id and d.kind='project_charge'
     where dl.equipment_unit_id=eu.id
  ) equipment_metrics on true`

export const EQUIPMENT_BUILT_IN_EXPR: Record<string, SQL> = {
  unit_number: sql`eu.unit_number`,
  name: sql`eu.name`,
  charge_item: sql`equipment_item.name`,
  serial_number: sql`eu.serial_number`,
  purchase_price: sql`eu.purchase_price`,
  recovery: sql`equipment_metrics.recovery`,
  billable: sql`equipment_metrics.billable`,
  status: sql`eu.status`,
}

export const EQUIPMENT_SORTS: Record<string, SQL> = {
  number: sql`eu.unit_number`,
  name: sql`eu.name`,
  item: sql`equipment_item.name`,
  purchase: sql`eu.purchase_price`,
  recovery: sql`equipment_metrics.recovery`,
  billable: sql`equipment_metrics.billable`,
  status: sql`eu.status`,
}

function equipmentFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const column = clause.key === 'status' ? sql`eu.status`
    : clause.key === 'charge_item_id' ? sql`eu.charge_item_id`
      : clause.key === 'fixed_asset_id' ? sql`eu.fixed_asset_id` : null
  if (!column) return null
  if (clause.operator === 'eq') return sql`${column} = ${value}`
  if (clause.operator === 'ne') return sql`${column} <> ${value}`
  return null
}

export function equipmentWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`eu.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and eu.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = equipmentFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and eu.status = ${adhoc.filters.status}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (eu.name ilike ${query} or eu.unit_number ilike ${query} or eu.serial_number ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Timesheet weeks                                                     */
/* ------------------------------------------------------------------ */

export const TIMESHEET_WEEK_BUILT_IN_EXPR: Record<string, SQL> = {
  employee_name: sql`employee.display_name`,
  week_start: sql`tw.week_start`,
  status: sql`tw.status`,
  total_hours: sql`to_char(tw.total_hours, 'FM999999990.00')`,
  billable_hours: sql`to_char(tw.billable_hours, 'FM999999990.00')`,
}

export const TIMESHEET_WEEK_SORTS: Record<string, SQL> = {
  employee: sql`employee.display_name`,
  week: sql`tw.week_start`,
  status: sql`tw.status`,
  total: sql`tw.total_hours`,
  billable: sql`tw.billable_hours`,
}

function timesheetWeekFilterPredicate(clause: FilterClause): SQL | null {
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  const column = clause.key === 'status' ? sql`tw.status`
    : clause.key === 'employee_party_id' ? sql`tw.employee_party_id` : null
  if (!column) return null
  if (clause.operator === 'eq') return sql`${column} = ${value}`
  if (clause.operator === 'ne') return sql`${column} <> ${value}`
  return null
}

export function timesheetWeekWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string): SQL {
  const parts: SQL[] = [sql`tw.org_id = ${orgId}`]
  for (const filter of view.filters) {
    const predicate = timesheetWeekFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and tw.status = ${adhoc.filters.status}`)
  if (adhoc.filters?.employee_party_id) parts.push(sql`and tw.employee_party_id = ${adhoc.filters.employee_party_id}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and employee.display_name ilike ${query}`)
  }
  return sql.join(parts, sql` `)
}

/* ------------------------------------------------------------------ */
/* Fixed assets                                                        */
/* ------------------------------------------------------------------ */

export const FIXED_ASSET_BASE_JOINS = sql`
  left join asset_categories c on c.id = a.category_id
  left join lateral (
    select coalesce(sum(l.posted_amount), 0) as accumulated
      from depreciation_schedules s
      join depreciation_schedule_lines l on l.schedule_id = s.id
     where s.asset_id = a.id and l.posted_amount is not null
  ) depr on true`

const FIXED_ASSET_NBV_EXPR = sql`a.acquisition_cost - depr.accumulated`

export const FIXED_ASSET_BUILT_IN_EXPR: Record<string, SQL> = {
  asset_number: sql`a.asset_number`,
  name: sql`a.name`,
  category_name: sql`c.name`,
  acquisition_cost: sql`a.acquisition_cost`,
  accumulated: sql`depr.accumulated`,
  net_book_value: FIXED_ASSET_NBV_EXPR,
  serial_number: sql`a.serial_number`,
  status: sql`a.status`,
}

export const FIXED_ASSET_SORTS: Record<string, SQL> = {
  number: sql`a.asset_number`,
  name: sql`a.name`,
  category: sql`c.name`,
  cost: sql`a.acquisition_cost`,
  accumulated: sql`depr.accumulated`,
  nbv: FIXED_ASSET_NBV_EXPR,
  status: sql`a.status`,
}

function fixedAssetFilterPredicate(clause: FilterClause): SQL | null {
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
  switch (clause.key) {
    case 'status': return select(sql`a.status`)
    case 'category_id':
      if (clause.operator === 'eq') return sql`a.category_id = ${value}`
      if (clause.operator === 'ne') return sql`a.category_id <> ${value}`
      return null
    case 'acquired_on':
      if (clause.operator === 'eq') return sql`a.acquired_on = ${value}`
      if (clause.operator === 'gte') return sql`a.acquired_on >= ${value}`
      if (clause.operator === 'lte') return sql`a.acquired_on <= ${value}`
      if (clause.operator === 'between') return sql`a.acquired_on between ${value} and ${String(clause.to ?? '')}`
      return null
    case 'serial_number':
      if (clause.operator === 'eq') return sql`a.serial_number = ${value}`
      if (clause.operator === 'contains') return sql`a.serial_number ilike ${`%${value}%`}`
      if (clause.operator === 'is_set') return sql`coalesce(a.serial_number, '') <> ''`
      if (clause.operator === 'is_not_set') return sql`coalesce(a.serial_number, '') = ''`
      return null
    default: return null
  }
}

export function fixedAssetWhere(
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
  allowedSubsidiaryIds?: Set<string> | null,
): SQL {
  const parts: SQL[] = [sql`a.org_id = ${orgId}`]
  if (allowedSubsidiaryIds) {
    const ids = [...allowedSubsidiaryIds]
    parts.push(ids.length ? sql`and a.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])` : sql`and false`)
  }
  for (const filter of view.filters) {
    const predicate = fixedAssetFilterPredicate(filter)
    if (predicate) parts.push(sql`and ${predicate}`)
  }
  if (adhoc.filters?.status) parts.push(sql`and a.status = ${adhoc.filters.status}`)
  if (adhoc.q) {
    const query = `%${adhoc.q}%`
    parts.push(sql`and (a.name ilike ${query} or a.asset_number ilike ${query} or a.serial_number ilike ${query})`)
  }
  return sql.join(parts, sql` `)
}

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
