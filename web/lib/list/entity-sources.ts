import { provisionProjectVisibility } from '@openbooks/engine/provisions'
import { financialChangeSubjectExpr, lifecycleWhere } from "../customization/entity-list-query/accounting-lifecycles";
import 'server-only'
import { accountListBalanceDrill } from '../account-balance-drill'
import { journalDraftScopeWhere } from '../customization/entity-list-query/journal-entries'
import type { ReportDrillTarget } from '../report-drill'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { fromMinorUnits } from '@openbooks/engine/payments/minor-units'
import { resolveProjectActualCosts } from '@openbooks/engine/src/projects/financials.ts'
import { cmp } from '@openbooks/engine/src/money/money.ts'
import { assertUnrestrictedScope } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { isCustomFieldKey, type FilterClause, type ListViewConfig } from '@openbooks/customization'
import { displayOpportunityStatusName } from '../crm-status-display'
import { subsidiaryVisibleFilter } from '../subsidiaries'
import { dateOrFalse, pushCustomFieldFilter, uuidOrFalse } from '../customization/list-query'
import {
  CUSTOMER_BASE_JOINS,
  CUSTOMER_BUILT_IN_EXPR,
  CUSTOMER_SORTS,
  CUSTOMER_STATUS_EXPR,
  PARTY_ACTIVE_STATUS_EXPR,
  PARTY_BUILT_IN_EXPR,
  PARTY_SORTS,
  PROJECT_BASE_JOINS,
  PROJECT_BUILT_IN_EXPR,
  PROJECT_COUNT_JOINS,
  PROJECT_SORTS,
  OPPORTUNITY_BASE_JOINS,
  OPPORTUNITY_BUILT_IN_EXPR,
  OPPORTUNITY_SORTS,
  FIXED_ASSET_BASE_JOINS,
  FIXED_ASSET_BUILT_IN_EXPR,
  FIXED_ASSET_SORTS,
  ACTIVITY_BASE_JOINS,
  ACTIVITY_BUILT_IN_EXPR,
  ACTIVITY_SORTS,
  ITEM_BUILT_IN_EXPR,
  ITEM_SORTS,
  ITEM_STATUS_EXPR,
  FAMILY_BUILT_IN_EXPR,
  FAMILY_SORTS,
  FAMILY_STATUS_EXPR,
  accountBaseJoins,
  ACCOUNT_BUILT_IN_EXPR,
  ACCOUNT_SORTS,
  ACCOUNT_STATUS_EXPR,
  accountWhere,
  JOURNAL_ENTRY_BUILT_IN_EXPR,
  JOURNAL_ENTRY_SORTS,
  JOURNAL_ENTRY_TABLE,
  journalEntryBaseJoins,
  journalEntryCountJoins,
  journalEntryWhere,
  INVENTORY_ONHAND_BUILT_IN_EXPR,
  INVENTORY_ONHAND_SORTS,
  INVENTORY_MOVEMENT_BASE_JOINS,
  INVENTORY_MOVEMENT_BUILT_IN_EXPR,
  INVENTORY_MOVEMENT_SORTS,
  inventoryOnhandWhere,
  inventoryMovementWhere,
  budgetBaseJoins,
  BUDGET_BUILT_IN_EXPR,
  BUDGET_SORTS,
  budgetScenarioScopeFilter,
  budgetWhere,
  REVENUE_CONTRACT_BASE_JOINS,
  REVENUE_CONTRACT_BUILT_IN_EXPR,
  REVENUE_CONTRACT_SORTS,
  revenueContractWhere,
  CONTRACT_COST_ASSET_BASE_JOINS,
  CONTRACT_COST_ASSET_BUILT_IN_EXPR,
  CONTRACT_COST_ASSET_SORTS,
  contractCostAssetWhere,
  EQUIPMENT_BASE_JOINS,
  EQUIPMENT_BUILT_IN_EXPR,
  EQUIPMENT_SORTS,
  equipmentWhere,
  TIMESHEET_WEEK_BUILT_IN_EXPR,
  TIMESHEET_WEEK_SORTS,
  timesheetWeekWhere,
  BANK_RECONCILIATION_BASE_JOINS,
  BANK_RECONCILIATION_BUILT_IN_EXPR,
  BANK_RECONCILIATION_SORTS,
  bankReconciliationWhere,
  BANK_STATEMENT_BASE_JOINS,
  BANK_STATEMENT_BUILT_IN_EXPR,
  BANK_STATEMENT_SORTS,
  bankStatementWhere,
  BANK_RULE_BUILT_IN_EXPR,
  BANK_RULE_SORTS,
  bankRuleWhere,
  PAYMENT_DISPUTE_BUILT_IN_EXPR,
  PAYMENT_DISPUTE_SORTS,
  paymentDisputeWhere,
  STORED_VALUE_BUILT_IN_EXPR,
  STORED_VALUE_SORTS,
  storedValueAccountWhere,
  activityWhere,
  customerWhere,
  employeeBaseJoins,
  employeeWhere,
  fixedAssetWhere,
  familyWhere,
  itemWhere,
  opportunityWhere,
  projectWhere,
  vendorWhere,
  type EntityAdhoc,
} from '../customization/entity-list-query'

/**
 * Entity-list data sources — the SQL half of the universal list for plain
 * (non-`documents`) tables such as `parties` and `projects`. Parallels lib/list/sources.ts
 * (documents-backed). components/entity-list-view.tsx renders any of these with
 * the same toolbar/table/view machinery; this registry is the ONLY place their
 * queries differ: which table/alias, joins, built-in column expressions, sort
 * expressions, where builder, and drill-through target.
 */
export interface EntityListSource {
  /** Customization record type key (must exist in RECORD_TYPES, category entity). */
  recordType: string
  /** Backing table and its alias. Derived aggregates may take orgId so the inner child scan is tenant-pinned. */
  table: string | ((orgId: string) => SQL)
  alias: string
  /** Selected row id when it is not `<alias>.id` (for joined/profile tables). */
  idExpr?: SQL
  /** Table whose custom_field_defs + `custom` jsonb back this list's cf_ columns. */
  customFieldTable?: string
  /** Alias whose `custom` jsonb stores list custom fields (defaults to alias). */
  customFieldAlias?: string
  /** Optional target kind for shared custom-field tables such as documents. */
  customFieldKind?: string
  /** FROM joins after `<table> <alias>`. */
  baseJoins: SQL | ((allowedSubsidiaryIds?: Set<string> | null, today?: string) => SQL)
  /**
   * Joins for the count/status-count queries when the row joins include work
   * the aggregates don't need (e.g. per-row lateral totals whose columns only
   * appear in SELECT). Must still include every join the WHERE references.
   * Defaults to baseJoins.
   */
  countJoins?: SQL | ((allowedSubsidiaryIds?: Set<string> | null, today?: string) => SQL)
  /** Built-in column key → SELECT expression. */
  builtInExpr: Record<string, SQL>
  /** Sort key → ORDER BY expression. */
  sorts: Record<string, SQL>
  /** Fallback ORDER BY when the requested sort key isn't in `sorts`. */
  defaultSort: SQL
  /** Expression grouped for the status filter/counts (defaults to alias.status). */
  statusExpr?: SQL
  /** Disable status grouping for aggregate lists with no status dimension. */
  statusCounts?: boolean
  /** Registry filter key represented by statusExpr (defaults to `status`). */
  countFilterKey?: string
  /** Reusable quick filters rendered between search and the saved-view picker. */
  quickFilters: EntityQuickFilter[]
  /** WHERE builder. */
  where: (
    view: ListViewConfig,
    adhoc: EntityAdhoc,
    orgId: string,
    allowedSubsidiaryIds?: Set<string> | null,
  ) => SQL
  /** URL param the actions cell toggles to open the edit drawer: /base?<param>=<id>. */
  drawerParam: string
  /** Base path for row links / drawer. */
  basePath: string
  /**
   * Canonical read grant for this list, enforced by the shared entity reader
   * before any compiler work (in addition to the page's own gate). Sources
   * without a declaration stay caller-gated.
   */
  readPermission?: string
  /** Where the reference column links (default: the edit drawer). Projects link
   *  to the full cockpit page instead. */
  /** The list has an `is_active` flag → show a "show inactive" toggle. */
  hasInactive?: boolean
  /** Always-selected extra fields (e.g. is_active for row styling). */
  extraSelect?: SQL
  /**
   * Amount-cell drill. The list wraps the formatted number in ReportDrillLink
   * when this returns a target. Receives the current-period window the flyout
   * opens with; the operator can then change it via the house period filter.
   */
  columnDrill?: (
    row: Record<string, unknown>,
    columnKey: string,
    ctx: { from: string; to: string; period: string },
  ) => ReportDrillTarget | null
  /** Row field containing the ISO currency for amount cells. */
  currencyField?: string
  /** Record-specific status semantics layered over the shared badge palette. */
  statusVariant?: (row: Record<string, unknown>, value: unknown, columnKey: string) => 'default' | 'success' | 'secondary' | 'warning' | 'outline' | 'destructive'
  /**
   * Translate DB-seeded status names for display (status cells + the status
   * quick-filter options). Some statuses live in the tenant database in
   * English; unrenamed seeds render through the catalog while tenant
   * renames keep their stored names.
   */
  statusDisplayName?: (storedName: string, translate: (fullKey: string) => string) => string
  /** Quick-filter key whose option labels are status names (translated via
   *  statusDisplayName). Unset when no quick filter carries status options. */
  statusFilterKey?: string
  /** Source-specific drawer target when rows do not all use one URL param. */
  drawerTarget?: (row: Record<string, unknown>) => { param: string; id: string }
  /** Mutually exclusive record selectors removed when a row opens. */
  exclusiveDrawerParams?: readonly string[]
  /** Client-loaded record detail may open without rerunning the list. */
  overlayDrawer?: boolean
  /** Page by inexpensive header columns before hydrating per-row aggregates. */
  pageBeforeJoins?: { table: string; sorts: readonly string[] }
  /** Full row href for read-only aggregate rows that do not own a drawer. */
  rowHref?: (row: Record<string, unknown>) => string
  /**
   * Post-fetch row enrichment, keyed by displayed rows. The project source
   * uses it to overwrite the SQL `actual` placeholder with the profile-driven
   * actual-cost reader the cockpit Financials tab reads, so the two "Actual
   * cost" figures tie. Sources without server-computed display values omit it.
   */
  enrichRows?: (orgId: string, rows: Record<string, unknown>[]) => Promise<void>
  /**
   * Planned page ids for sorts SQL cannot serve without a per-row scan over
   * a huge table (project Actual cost is profile-driven and FX-translated).
   * The list fetches the filtered id set through the source's own joins and
   * WHERE, resolves the sort values in ONE batched reader over that set,
   * and reads the page by id membership ordered by array position — never a
   * correlated per-row sum. Return null to fall back to SQL
   * ordering. Only consulted when defined.
   */
  orderedPageIds?: (ctx: {
    orgId: string
    sort: string
    dir: "asc" | "desc"
    tableSql: SQL
    baseJoins: SQL
    where: SQL
  }) => Promise<string[] | null>
}

/**
 * Inventory's shared predicates predate subsidiary ownership and therefore
 * only apply the tenant and list filters. Keep the source-specific extension
 * here so the universal list's row, count, and status queries all use the
 * caller's visibility policy without changing the shared customization API.
 */
const inventoryOnhandScopedWhere: EntityListSource['where'] = (
  view,
  adhoc,
  orgId,
  allowedSubsidiaryIds,
) => sql`${inventoryOnhandWhere(view, adhoc, orgId)}${subsidiaryVisibleFilter(sql`oh.subsidiary_id`, allowedSubsidiaryIds ?? null)}`

const inventoryMovementScopedWhere: EntityListSource['where'] = (
  view,
  adhoc,
  orgId,
  allowedSubsidiaryIds,
) => sql`${inventoryMovementWhere(view, adhoc, orgId)}${subsidiaryVisibleFilter(sql`m.subsidiary_id`, allowedSubsidiaryIds ?? null)}`

function pushNonprofitStatusFilter(
  parts: SQL[],
  filter: FilterClause,
  statusExpr: SQL, statuses: readonly string[],
): boolean {
  if (filter.key !== 'status') return false
  const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map(String)
  if (values.some((value) => !statuses.includes(value))) { parts.push(sql`and false`); return true }
  const list = sql.join(values.map((value) => sql`${value}`), sql`, `)
  if ((filter.operator === 'eq' || filter.operator === 'ne') && values.length === 1) parts.push(filter.operator === 'eq' ? sql`and ${statusExpr} = ${values[0]}` : sql`and ${statusExpr} <> ${values[0]}`)
  else if (filter.operator === 'in' || filter.operator === 'not_in') parts.push(values.length ? sql`and ${statusExpr} ${filter.operator === 'in' ? sql`in` : sql`not in`} (${list})`
    : filter.operator === 'in' ? sql`and false` : sql`and true`)
  else parts.push(sql`and false`)
  return true
}
type ResourcingSourceWhere = {
  alias: string
  columns: Record<string, SQL>
  dates?: readonly string[]
  uuids?: readonly string[]
  booleans?: readonly string[]
  searchColumns: readonly SQL[]
  statusKey?: string
  subsidiary: SQL
}

function resourcingFilterPredicate(clause: FilterClause, config: ResourcingSourceWhere): SQL {
  const column = config.columns[clause.key]
  if (!column) return sql`false`
  const value = Array.isArray(clause.value) ? String(clause.value[0] ?? '') : String(clause.value ?? '')
  if (config.uuids?.includes(clause.key)) {
    const refused = uuidOrFalse(value)
    if (refused) return refused
  }
  if (config.dates?.includes(clause.key)) {
    const refused = dateOrFalse(value)
    if (refused) return refused
    if (clause.operator === 'between') {
      const upper = String(clause.to ?? '')
      const refusedUpper = dateOrFalse(upper)
      if (refusedUpper) return refusedUpper
      return sql`${column} between ${value} and ${upper}`
    }
    if (clause.operator === 'eq') return sql`${column} = ${value}`
    if (clause.operator === 'gte') return sql`${column} >= ${value}`
    if (clause.operator === 'lte') return sql`${column} <= ${value}`
    return sql`false`
  }
  if (config.booleans?.includes(clause.key)) {
    if (value !== 'true' && value !== 'false') return sql`false`
    return clause.operator === 'eq' ? sql`${column} = ${value}::boolean` : sql`false`
  }
  if (clause.operator === 'eq') return sql`${column} = ${value}`
  if (clause.operator === 'ne') return sql`${column} <> ${value}`
  if (clause.operator === 'contains') return sql`${column}::text ilike ${`%${value}%`}`
  if (clause.operator === 'is_set') return sql`coalesce(${column}::text, '') <> ''`
  if (clause.operator === 'is_not_set') return sql`coalesce(${column}::text, '') = ''`
  if (clause.operator === 'in' || clause.operator === 'not_in') {
    const values = (Array.isArray(clause.value) ? clause.value : [value]).map(String)
    if (!values.length) return clause.operator === 'in' ? sql`false` : sql`true`
    const list = sql.join(values.map((item) => sql`${item}`), sql`, `)
    return clause.operator === 'in' ? sql`${column} in (${list})` : sql`${column} not in (${list})`
  }
  return sql`false`
}

function resourcingWhere(
  config: ResourcingSourceWhere,
  view: ListViewConfig,
  adhoc: EntityAdhoc,
  orgId: string,
): SQL {
  const parts: SQL[] = [sql`${sql.raw(config.alias)}.org_id = ${orgId}`, config.subsidiary]
  for (const filter of view.filters) {
    if (pushCustomFieldFilter(parts, filter, config.alias)) continue
    parts.push(sql`and ${resourcingFilterPredicate(filter, config)}`)
  }
  const status = config.statusKey ? adhoc.filters?.[config.statusKey] : undefined
  if (status && config.statusKey) parts.push(sql`and ${config.columns[config.statusKey]} = ${status}`)
  if (adhoc.q) {
    const pattern = `%${adhoc.q}%`
    parts.push(sql`and (${sql.join(config.searchColumns.map((column) => sql`${column}::text ilike ${pattern}`), sql` or `)})`)
  }
  return sql.join(parts, sql` `)
}

export interface EntityQuickFilterOption {
  value: string
  label: string
  count?: number
}

export interface EntityQuickFilter {
  /** URL query parameter, which may differ from the registry key for compatibility. */
  paramKey: string
  /** Customization registry filter key and key passed to the WHERE builder. */
  filterKey: string
  /** Default quick-filter value unless the selected saved view owns this filter. */
  defaultValue?: string
  /** Dynamic option source; static select options come from the customization registry. */
  loadOptions?: (orgId: string, allowedSubsidiaryIds?: Set<string> | null) => Promise<EntityQuickFilterOption[]>
}

const provisionJoins = sql`join subsidiaries sub on sub.org_id=p.org_id and sub.id=p.subsidiary_id
  join accounting_books book on book.org_id=p.org_id and book.id=p.book_id
  left join lateral (select coalesce(sum(-line.amount),0) as balance from journal_lines line
    join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
    where line.org_id=p.org_id and entry.book_id=p.book_id and line.subsidiary_id=p.subsidiary_id
      and line.account_id=p.liability_account_id and line.custom->>'provisionId'=p.id::text
      and entry.status in ('posted','reversed')) gl on true
  left join lateral (select fc.id,fc.effective_on,fc.result from financial_changes fc where fc.org_id=p.org_id
    and fc.domain='provision' and fc.subject_id=p.id and fc.status='applied'
    order by fc.effective_on desc,fc.applied_at desc,fc.id desc limit 1) review on true`
const provisionStatus = sql`case when review.id is null then 'unassessed'
  when review.result->>'recognized'='true' then 'recognized' else 'contingent' end`

const SOURCES: Record<string, EntityListSource> = {
  webhook_endpoint: {
    recordType: 'webhook_endpoint', table: 'webhook_endpoints', alias: 'e', readPermission: 'webhooks.read',
    baseJoins: sql``, countJoins: sql``,
    builtInExpr: {
      key: sql`e.key`, url: sql`e.url`, description: sql`e.description`,
      events_count: sql`coalesce(cardinality(e.events), 0)`,
      status: sql`e.status`, consecutive_failures: sql`e.consecutive_failures`,
      auto_disabled: sql`(e.status = 'disabled' and e.disabled_reason is not null and e.disabled_reason <> 'Disabled by the operator.')`,
      last_delivery_at: sql`to_char(e.last_delivery_at, 'YYYY-MM-DD HH24:MI')`,
      last_delivery_status: sql`e.last_delivery_status`,
    },
    sorts: {
      key: sql`e.key`, status: sql`e.status`, failures: sql`e.consecutive_failures`,
      last_delivery: sql`e.last_delivery_at`,
    },
    defaultSort: sql`e.key`,
    statusExpr: sql`e.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId) => {
      const parts: SQL[] = [sql`e.org_id=${orgId}`]
      for (const filter of view.filters) {
        if (filter.key === 'status') pushNonprofitStatusFilter(parts, filter, sql`e.status`, ['active', 'disabled'])
        else parts.push(sql`and false`)
      }
      if (adhoc.q) parts.push(sql`and (e.key ilike ${`%${adhoc.q}%`} or e.url ilike ${`%${adhoc.q}%`} or e.description ilike ${`%${adhoc.q}%`})`)
      if (adhoc.filters?.status) parts.push(sql`and e.status=${adhoc.filters.status}`)
      return sql.join(parts, sql` `)
    },
    drawerParam: 'endpoint', basePath: '/admin/webhooks',
    statusVariant: (row, value) => value === 'active'
      ? (Number(row.consecutive_failures ?? 0) > 0 ? 'warning' : 'success')
      : row.auto_disabled ? 'destructive' : 'secondary',
  },

  provision_obligation: {
    recordType: 'provision_obligation', table: 'provision_obligations', alias: 'p', readPermission: 'gl.read', currencyField: 'currency',
    baseJoins: provisionJoins, countJoins: provisionJoins,
    builtInExpr: { name: sql`p.name`, subsidiary: sql`sub.name`, book: sql`book.name`, currency: sql`p.currency`,
      balance: sql`gl.balance`, reviewed_on: sql`review.effective_on`, status: provisionStatus },
    sorts: { name: sql`p.name`, subsidiary: sql`sub.name`, book: sql`book.name`, balance: sql`gl.balance`, reviewed_on: sql`review.effective_on`, status: provisionStatus },
    defaultSort: sql`p.name`, statusExpr: provisionStatus, quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId, allowed) => {
      const parts = [sql`p.org_id=${orgId}`,sql`and ${provisionProjectVisibility()}`, subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed === undefined ? new Set<string>() : allowed)]
      for (const filter of view.filters) {
        if (filter.key === 'status') pushNonprofitStatusFilter(parts, filter, provisionStatus, ['unassessed', 'recognized', 'contingent'])
        else parts.push(sql`and false`)
      }
      if (adhoc.q) parts.push(sql`and p.name ilike ${`%${adhoc.q}%`}`)
      if (adhoc.filters?.status) parts.push(sql`and ${provisionStatus}=${adhoc.filters.status}`)
      return sql.join(parts, sql` `)
    },
    drawerParam: 'provision', basePath: '/accounting/provisions',
    statusVariant: (_row, value) => value === 'unassessed' ? 'warning' : 'outline',
  },

  hrm_process_template: {
    recordType: 'hrm_process_template', table: 'hrm_process_templates', alias: 't',
    readPermission: 'hrm.process.manage',
    baseJoins: sql`left join lateral (
      select count(*)::int as step_count from hrm_process_template_steps step
       where step.org_id=t.org_id and step.template_id=t.id and step.is_current
    ) steps on true`,
    countJoins: sql``,
    builtInExpr: {
      name: sql`coalesce(t.draft_document->>'name',t.name)`, kind: sql`t.kind`,
      scope: sql`case when t.applies_to->>'employer_subsidiary_id' is not null or t.applies_to->>'department_id' is not null then 'limited' else 'all' end`,
      step_count: sql`case when t.draft_document is not null then jsonb_array_length(t.draft_document->'steps') else steps.step_count end`, published_version:sql`t.published_version`,
      status: sql`case when t.designer_managed and t.published_version=0 and not t.is_active then 'draft' when t.is_active and t.draft_revision>t.published_revision then 'changes_pending' when t.is_active then 'active' else 'retired' end`,
    },
    sorts: { name: sql`coalesce(t.draft_document->>'name',t.name)`, kind: sql`t.kind`, steps: sql`steps.step_count`, status: sql`t.is_active` },
    defaultSort: sql`coalesce(t.draft_document->>'name',t.name)`,
    statusExpr: sql`case when t.designer_managed and t.published_version=0 and not t.is_active then 'draft' when t.is_active and t.draft_revision>t.published_revision then 'changes_pending' when t.is_active then 'active' else 'retired' end`,
    quickFilters: [{ paramKey: 'kind', filterKey: 'kind' }, { paramKey: 'status', filterKey: 'status' }],
    // Both the published definition and its draft must be visible in the
    // caller's employer scope; a draft move cannot expose configuration elsewhere.
    where: (view, adhoc, orgId, allowed) => {
      const parts: SQL[] = [sql`t.org_id=${orgId}`]
      if(allowed!==null) {
        if(!allowed || allowed.size===0) parts.push(sql`and false`)
        else parts.push(sql`and (t.applies_to->>'employer_subsidiary_id' in(select value from jsonb_array_elements_text(${JSON.stringify([...allowed])}::jsonb) as ids(value)) or (t.applies_to->>'employer_subsidiary_id' is null and (t.applies_to->>'department_id' is null or exists(select 1 from departments d where d.org_id=t.org_id and d.id::text=t.applies_to->>'department_id' and (d.subsidiary_id is null or d.subsidiary_id::text in(select value from jsonb_array_elements_text(${JSON.stringify([...allowed])}::jsonb) as ids(value)))))))`)
      }
      if (allowed !== null && allowed?.size) {
        parts.push(sql`and (t.draft_document is null or t.draft_document->'appliesTo'->>'employerSubsidiaryId' in(select value from jsonb_array_elements_text(${JSON.stringify([...allowed])}::jsonb) as ids(value)) or (t.draft_document->'appliesTo'->>'employerSubsidiaryId' is null and (t.draft_document->'appliesTo'->>'departmentId' is null or exists(select 1 from departments d where d.org_id=t.org_id and d.id::text=t.draft_document->'appliesTo'->>'departmentId' and (d.subsidiary_id is null or d.subsidiary_id::text in(select value from jsonb_array_elements_text(${JSON.stringify([...allowed])}::jsonb) as ids(value)))))))`)
      }
      const status = sql`case when t.designer_managed and t.published_version=0 and not t.is_active then 'draft' when t.is_active and t.draft_revision>t.published_revision then 'changes_pending' when t.is_active then 'active' else 'retired' end`
      for (const filter of view.filters) {
        if (filter.key === 'status') pushNonprofitStatusFilter(parts, filter, status, ['draft','changes_pending','active','retired'])
        else if (filter.key === 'kind') pushNonprofitStatusFilter(parts, { ...filter, key: 'status' }, sql`t.kind`, ['onboarding', 'offboarding', 'transfer'])
        else parts.push(sql`and false`)
      }
      if (adhoc.q) parts.push(sql`and (coalesce(t.draft_document->>'name',t.name) ilike ${`%${adhoc.q}%`} or t.kind ilike ${`%${adhoc.q}%`})`)
      if (adhoc.filters?.status) parts.push(sql`and ${status}=${adhoc.filters.status}`)
      if (adhoc.filters?.kind) parts.push(sql`and t.kind=${adhoc.filters.kind}`)
      return sql.join(parts, sql` `)
    },
    drawerParam: 'template', basePath: '/hrm/processes/templates',
    statusVariant: (_row, value) => value === 'active' ? 'success' : value==='changes_pending'?'warning':'outline',
  },

  change_set: {
    recordType: 'change_set', table: 'change_sets', alias: 'cs', baseJoins: sql``,
    builtInExpr: { name: sql`cs.name`, status: sql`cs.status`, created: sql`to_char(cs.created_at, 'YYYY-MM-DD HH24:MI')` },
    sorts: { name: sql`cs.name`, status: sql`cs.status`, created: sql`cs.created_at` },
    defaultSort: sql`cs.created_at`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId) => {
      const parts = [sql`cs.org_id=${orgId}`];
      if (adhoc.q) parts.push(sql`and cs.name ilike ${`%${adhoc.q}%`}`);
      if (adhoc.filters?.status) parts.push(sql`and cs.status=${adhoc.filters.status}`);
      for (const filter of view.filters) {
        if (isCustomFieldKey(filter.key)) {
          parts.push(sql`and false`);
          continue;
        }
        if (filter.key !== 'status') continue;
        const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).map(String);
        if (filter.operator === 'eq') parts.push(sql`and cs.status=${values[0]}`);
        else if (filter.operator === 'ne') parts.push(sql`and cs.status<>${values[0]}`);
        else if (filter.operator === 'in' || filter.operator === 'not_in') {
          const list = sql.join(values.map(value => sql`${value}`), sql`, `);
          parts.push(values.length ? sql`and cs.status ${filter.operator === 'in' ? sql`in` : sql`not in`} (${list})`
            : filter.operator === 'in' ? sql`and false` : sql`and true`);
        }
      }
      return sql.join(parts, sql` `);
    },
    drawerParam: 'changeSet', basePath: '/admin/sandboxes/change-sets',
  },
  customer: {
    recordType: 'customer',
    table: 'parties',
    alias: 'p',
    customFieldTable: 'parties',
    baseJoins: CUSTOMER_BASE_JOINS,
    builtInExpr: CUSTOMER_BUILT_IN_EXPR,
    sorts: CUSTOMER_SORTS,
    defaultSort: sql`p.display_name`,
    statusExpr: CUSTOMER_STATUS_EXPR,
    // Lifecycle first (the segment the page is on), then the CRM sub-status,
    // owner and territory the retired lead/prospect lists used to carry.
    // Defaulting the segment to `customer` keeps the AR-facing list showing
    // customers; the chips move it across the rest of the lifecycle.
    // entity-list-view drops the CRM three when the switch is off.
    quickFilters: [
      { paramKey: 'status', filterKey: 'status', defaultValue: 'customer' },
      {
        paramKey: 'accountStatus',
        filterKey: 'status_id',
        loadOptions: async (orgId) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select id::text as value, name as label
              from crm_account_statuses
             where org_id=${orgId} and is_active
             order by lifecycle_stage, sequence, name`)
          return result.rows
        },
      },
      {
        paramKey: 'owner',
        filterKey: 'owner_user_id',
        loadOptions: async (orgId) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select id::text as value, name as label from users
             where org_id=${orgId} and is_active order by name`)
          return result.rows
        },
      },
    ],
    where: customerWhere,
    drawerParam: 'party',
    basePath: '/entities/customers',
    hasInactive: true,
    extraSelect: sql`p.is_active`,
  },
  vendor: {
    recordType: 'vendor',
    table: 'parties',
    alias: 'p',
    customFieldTable: 'parties',
    baseJoins: sql``,
    builtInExpr: PARTY_BUILT_IN_EXPR,
    sorts: PARTY_SORTS,
    defaultSort: sql`p.display_name`,
    statusExpr: PARTY_ACTIVE_STATUS_EXPR,
    quickFilters: [],
    where: vendorWhere,
    drawerParam: 'party',
    basePath: '/entities/vendors',
    hasInactive: true,
    extraSelect: sql`p.is_active`,
  },
  employee: {
    recordType: 'employee',
    table: 'parties',
    alias: 'p',
    customFieldTable: 'parties',
    // HRM on by default here (the CRM-on twin of CUSTOMER_BASE_JOINS):
    // entity-list-view overrides with the request's feature state, and the
    // where builder fails directory filters closed while the switch is off.
    // The source-level joins are always emitted (the HRM tables exist whether
    // or not the switch is on); the list view re-derives them from the real
    // switch and passes the same answer as adhoc.hrmEnabled, which is what
    // employeeWhere reads. Any other caller that keeps these joins but says
    // nothing gets directory filters that match nothing, never a SQL error.
    baseJoins: (allowedSubsidiaryIds, today) => employeeBaseJoins(true, today!, allowedSubsidiaryIds),
    builtInExpr: PARTY_BUILT_IN_EXPR,
    sorts: PARTY_SORTS,
    defaultSort: sql`p.display_name`,
    statusExpr: PARTY_ACTIVE_STATUS_EXPR,
    quickFilters: [
      {
        paramKey: 'department',
        filterKey: 'department',
        loadOptions: async (orgId) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select id::text as value, name as label
              from departments
             where org_id = ${orgId} and is_active
             order by name`)
          return result.rows
        },
      },
      { paramKey: 'employmentStatus', filterKey: 'employment_status' },
      {
        paramKey: 'employer',
        filterKey: 'employer',
        loadOptions: async (orgId, allowedSubsidiaryIds) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select id::text as value, name as label
              from subsidiaries
             where org_id = ${orgId} and is_active
               ${subsidiaryVisibleFilter(sql`id`, allowedSubsidiaryIds ?? null)}
             order by name`)
          return result.rows
        },
      },
    ],
    where: employeeWhere,
    drawerParam: 'party',
    basePath: '/entities/employees',
    hasInactive: true,
    extraSelect: sql`p.is_active`,
  },
  project: {
    recordType: 'project',
    table: 'projects',
    alias: 'p',
    customFieldTable: 'projects',
    baseJoins: PROJECT_BASE_JOINS,
    countJoins: PROJECT_COUNT_JOINS,
    builtInExpr: PROJECT_BUILT_IN_EXPR,
    sorts: PROJECT_SORTS,
    defaultSort: sql`p.name`,
    where: projectWhere,
    orderedPageIds: async ({ orgId, sort, dir, tableSql, baseJoins, where }) => {
      if (sort !== 'actual') return null
      // The filtered id set through the list's own joins/WHERE (projects
      // only — no journal lines), then ONE batched profile-driven cost read
      // over that set. Sorting by the same reader the rows display keeps the
      // order tied to the cockpit by construction.
      const found = await db.execute<{ id: string }>(sql`
        select p.id from ${tableSql} ${baseJoins} where ${where}`)
      const ids = [...new Set(found.rows.map((r) => String(r.id ?? '')).filter((id) => id.length > 0))]
      if (ids.length === 0) return []
      // Misconfigured rows carry no cost (never a fake zero): they rank as
      // zero for ordering stability and render their error beside the cell.
      const { costs } = await resolveProjectActualCosts(orgId, ids)
      const rank = (id: string) => costs.get(id) ?? '0'
      const sign = dir === 'asc' ? 1 : -1
      ids.sort((a, b) => sign * cmp(rank(a), rank(b)) || sign * (a < b ? -1 : a > b ? 1 : 0))
      return ids
    },
    quickFilters: [
      { paramKey: 'status', filterKey: 'status' },
      {
        paramKey: 'billing',
        filterKey: 'project_type',
        loadOptions: async (orgId) => {
          // Custom project types are tenant data: without them their keys
          // render underscore-spaced in cells and cannot be filtered at all.
          // Built-ins keep their static translated options — the list merges
          // these in after, so they still win on any value collision.
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select key as value, name as label from project_types
             where org_id = ${orgId} and is_active order by name`)
          return result.rows
        },
      },
    ],
    drawerParam: 'project',
    basePath: '/projects',
    readPermission: 'projects.read',
    hasInactive: true,
    extraSelect: sql`p.is_active`,
    enrichRows: async (orgId, rows) => {
      const ids = rows.map((row) => String(row.id ?? '')).filter((id) => id.length > 0)
      if (ids.length === 0) return
      const { costs, profileErrors } = await resolveProjectActualCosts(orgId, ids)
      for (const row of rows) {
        const id = String(row.id ?? '')
        const error = profileErrors.get(id)
        if (error !== undefined) {
          // A misconfigured billing classification is per-row error state,
          // not a zero: the cell renders an em-dash with the reason.
          row.actual = null
          row.actualError = error
          continue
        }
        const cost = costs.get(id)
        if (cost !== undefined) row.actual = cost
      }
    },
  },
  opportunity: {
    recordType: 'opportunity',
    table: 'crm_opportunities',
    alias: 'o',
    customFieldTable: 'crm_opportunities',
    baseJoins: OPPORTUNITY_BASE_JOINS,
    builtInExpr: OPPORTUNITY_BUILT_IN_EXPR,
    sorts: OPPORTUNITY_SORTS,
    defaultSort: sql`o.expected_close_date`,
    statusExpr: sql`o.status_id`,
    countFilterKey: 'status_id',
    quickFilters: [
      {
        paramKey: 'status',
        filterKey: 'status_id',
        loadOptions: async (orgId) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select id::text as value, name as label
              from crm_opportunity_statuses
             where org_id = ${orgId} and is_active
             order by sequence, name`)
          return result.rows
        },
      },
      {
        paramKey: 'owner',
        filterKey: 'owner_user_id',
        loadOptions: async (orgId) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select id::text as value, name as label
              from users
             where org_id = ${orgId} and is_active
             order by name`)
          return result.rows
        },
      },
      { paramKey: 'category', filterKey: 'forecast_category' },
    ],
    where: opportunityWhere,
    drawerParam: 'opportunity',
    basePath: '/crm/opportunities',
    extraSelect: sql`o.currency, s.is_closed, s.is_won`,
    currencyField: 'currency',
    statusVariant: (row) => row.is_won ? 'success' : row.is_closed ? 'outline' : 'default',
    // The status column selects s.name — the English seed row — so the list
    // translates it through the same catalog the drawer pill uses. A locale
    // without the subtree keeps the stored name, never a raw message key.
    statusFilterKey: 'status_id',
    statusDisplayName: (storedName, translate) =>
      displayOpportunityStatusName(storedName, (key) => {
        const fullKey = `crm.opportunities.statuses.${key}`
        const out = translate(fullKey)
        return out === fullKey ? storedName : out
      }),
  },
  fixed_asset: {
    recordType: 'fixed_asset',
    table: 'fixed_assets',
    alias: 'a',
    customFieldTable: 'fixed_assets',
    baseJoins: FIXED_ASSET_BASE_JOINS,
    builtInExpr: FIXED_ASSET_BUILT_IN_EXPR,
    sorts: FIXED_ASSET_SORTS,
    defaultSort: sql`a.asset_number`,
    statusExpr: sql`a.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: fixedAssetWhere,
    drawerParam: 'asset',
    basePath: '/assets',
    statusVariant: (row) => row.status === 'in_service' ? 'success' : row.status === 'draft' ? 'outline' : row.status === 'fully_depreciated' ? 'secondary' : 'warning',
  },
  activity: {
    recordType: 'activity',
    table: 'crm_activities',
    alias: 'a',
    customFieldTable: 'crm_activities',
    baseJoins: ACTIVITY_BASE_JOINS,
    builtInExpr: ACTIVITY_BUILT_IN_EXPR,
    sorts: ACTIVITY_SORTS,
    defaultSort: sql`coalesce(a.starts_at, a.due_at, a.created_at)`,
    statusExpr: sql`a.status`,
    quickFilters: [
      { paramKey: 'kind', filterKey: 'kind' },
      { paramKey: 'status', filterKey: 'status' },
      {
        paramKey: 'owner',
        filterKey: 'assigned_user_id',
        loadOptions: async (orgId) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`select id::text as value, name as label from users where org_id=${orgId} and is_active order by name`)
          return result.rows
        },
      },
    ],
    where: activityWhere,
    drawerParam: 'activity',
    basePath: '/crm/activities',
    statusVariant: (row) => row.status === 'completed' ? 'success' : 'outline',
  },
  item: {
    recordType: 'item',
    table: 'items',
    alias: 'i',
    customFieldTable: 'items',
    baseJoins: sql`left join item_families fam on fam.id = i.family_id and fam.org_id = i.org_id`,
    builtInExpr: ITEM_BUILT_IN_EXPR,
    sorts: ITEM_SORTS,
    defaultSort: sql`i.name`,
    statusExpr: ITEM_STATUS_EXPR,
    quickFilters: [{ paramKey: 'kind', filterKey: 'kind' }, { paramKey: 'family', filterKey: 'family' }],
    where: itemWhere,
    drawerParam: 'item',
    basePath: '/items',
    hasInactive: true,
    extraSelect: sql`i.is_active`,
    statusVariant: (row) => row.is_active ? 'success' : 'outline',
  },
  item_family: {
    recordType: 'item_family',
    table: 'item_families',
    alias: 'f',
    baseJoins: sql``,
    builtInExpr: FAMILY_BUILT_IN_EXPR,
    sorts: FAMILY_SORTS,
    defaultSort: sql`f.name`,
    statusExpr: FAMILY_STATUS_EXPR,
    quickFilters: [{ paramKey: 'kind', filterKey: 'kind' }],
    where: familyWhere,
    drawerParam: 'family',
    basePath: '/items/families',
    hasInactive: true,
    statusVariant: (row) => row.status === 'active' ? 'success' : 'outline',
  },
  account: {
    recordType: 'account',
    table: 'accounts',
    alias: 'a',
    customFieldTable: 'accounts',
    baseJoins: (allowed, today) => accountBaseJoins(today!, allowed),
    builtInExpr: ACCOUNT_BUILT_IN_EXPR,
    sorts: ACCOUNT_SORTS,
    defaultSort: sql`a.number`,
    statusExpr: ACCOUNT_STATUS_EXPR,
    quickFilters: [{ paramKey: 'class', filterKey: 'class' }],
    where: accountWhere,
    drawerParam: 'account',
    basePath: '/accounts',
    hasInactive: true,
    extraSelect: sql`a.is_active, a.type as drill_account_type, a.number as drill_account_number, a.name as drill_account_name`,
    columnDrill: accountListBalanceDrill,
    statusVariant: (row) => row.is_active ? 'success' : 'outline',
  },
  journal: {
    recordType: 'journal',
    table: JOURNAL_ENTRY_TABLE,
    alias: 'e',
    customFieldTable: 'documents',
    customFieldKind: 'journal',
    customFieldAlias: 'source_doc',
    baseJoins: journalEntryBaseJoins,
    // Saved cf_* filters bind against source_doc.custom, so the count/status
    // queries must keep that lateral. Visibility still lives in the table
    // union; the line-totals lateral stays on the row query only.
    countJoins: journalEntryCountJoins,
    builtInExpr: JOURNAL_ENTRY_BUILT_IN_EXPR,
    sorts: JOURNAL_ENTRY_SORTS,
    defaultSort: sql`e.posting_date`,
    statusExpr: sql`e.status`,
    quickFilters: [
      { paramKey: 'origin', filterKey: 'origin' },
      { paramKey: 'status', filterKey: 'status' },
    ],
    where: journalEntryWhere,
    readPermission: 'gl.read',
    drawerParam: 'journalEntry',
    overlayDrawer: true,
    exclusiveDrawerParams: ['entry', 'entryNew', 'journalEntry', 'txn', 'reportRecord', 'reportRecordKind', 'accountRegister', 'form', 'mode', 'transactionTab'],
    pageBeforeJoins: { table: 'journal_entries', sorts: ['date', 'number', 'origin', 'status'] },
    basePath: '/journal',
    extraSelect: sql`source_doc.id as source_document_id, source_doc.kind as source_document_kind`,
    statusVariant: (row) => row.status === 'posted' ? 'success' : row.status === 'reversed' ? 'destructive' : 'secondary',
  },
  journal_draft: {
    recordType: 'journal_draft',
    table: `(select id, org_id, kind, status, subsidiary_id, memo, custom,
                    document_date as posting_date, document_number as entry_number,
                    'manual'::text as origin
               from documents where kind = 'journal' and status = 'draft')`,
    alias: 'e',
    customFieldTable: 'documents',
    customFieldKind: 'journal',
    customFieldAlias: 'e',
    baseJoins: sql`join lateral (
      select coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as total_debits
        from document_lines l where l.document_id = e.id and l.org_id = e.org_id
    ) entry_totals on true`,
    countJoins: sql``,
    builtInExpr: { ...JOURNAL_ENTRY_BUILT_IN_EXPR, line_count: sql`null` },
    sorts: { date: sql`e.posting_date`, number: sql`e.entry_number`, debits: sql`entry_totals.total_debits`, status: sql`e.status` },
    defaultSort: sql`e.posting_date`,
    statusExpr: sql`e.status`,
    quickFilters: [],
    where: (view, adhoc, orgId, allowed) => {
      // Drafts have no posted ledger lines yet: authorize their document entity.
      const predicate = journalEntryWhere(view, adhoc, orgId, null, 'e')
      return sql`${predicate} and ${journalDraftScopeWhere(orgId, allowed ?? null)}`
    },
    readPermission: 'gl.read',
    drawerParam: 'entry',
    exclusiveDrawerParams: ['entry', 'entryNew', 'journalEntry', 'txn', 'reportRecord', 'reportRecordKind', 'accountRegister', 'form', 'mode', 'transactionTab'],
    basePath: '/journal',
    statusVariant: () => 'secondary',
  },
  inventory_onhand: {
    recordType: 'inventory_onhand',
    table: `(select org_id, subsidiary_id, item_id, stock_location_id,
                    sum(remaining_quantity) as quantity,
                    sum(round(remaining_quantity * unit_cost, 4)) as value
               from cost_layers
              where remaining_quantity > 0
              group by org_id, subsidiary_id, item_id, stock_location_id)`,
    alias: 'oh',
    idExpr: sql`oh.subsidiary_id::text || ':' || oh.item_id::text || ':' || oh.stock_location_id::text`,
    customFieldTable: 'items',
    customFieldAlias: 'it',
    baseJoins: sql`join items it on it.id=oh.item_id and it.org_id=oh.org_id join stock_locations sl on sl.id=oh.stock_location_id and sl.org_id=oh.org_id`,
    builtInExpr: INVENTORY_ONHAND_BUILT_IN_EXPR,
    sorts: INVENTORY_ONHAND_SORTS,
    defaultSort: sql`it.name`,
    statusCounts: false,
    quickFilters: [],
    where: inventoryOnhandScopedWhere,
    drawerParam: 'item',
    basePath: '/inventory',
    extraSelect: sql`oh.item_id`,
    rowHref: (row) => `/items?item=${row.item_id}`,
  },
  demand_suggestion: {
    recordType: 'demand_suggestion',
    table: 'demand_plan_suggestions',
    alias: 's',
    readPermission: 'inventory.plan',
    baseJoins: sql`join demand_forecast_runs r on r.org_id = s.org_id and r.id = s.run_id
      join items i on i.org_id = s.org_id and i.id = s.item_id
      join stock_locations sl on sl.org_id = s.org_id and sl.id = s.stock_location_id
      left join subsidiaries sub on sub.org_id = s.org_id and sub.id::text = r.parameters->>'subsidiaryId'
      left join demand_item_policies pol on pol.org_id = s.org_id and pol.item_id = s.item_id
      left join parties pty on pty.org_id = s.org_id and pty.id = pol.preferred_supplier_id
      left join lateral (
        -- The receipt-vendor fallback reads the same most-recent live
        -- receipt the planning engine resolves, so the list and the drawer
        -- never name different suppliers for one suggestion.
        select p2.display_name as name
          from inventory_movements m
          join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
          join documents d on d.id = l.document_id and d.org_id = l.org_id
          join parties p2 on p2.id = d.party_id and p2.org_id = d.org_id
         where m.org_id = s.org_id and m.item_id = s.item_id
           and m.kind = 'receipt' and m.status = 'posted'
           and m.reverses_movement_id is null
           and not exists (
             select 1 from inventory_movements reversal
              where reversal.org_id = m.org_id and reversal.reverses_movement_id = m.id)
           and d.kind in ('purchase_receipt', 'vendor_bill')
         order by m.moved_at desc, m.id desc limit 1) receipt on true
      left join lateral (
        select coalesce(jsonb_agg(d.qty order by d.week_start), '[]'::jsonb) as weeks
          from (
            select date_trunc('week', m.moved_at)::date as week_start,
                   sum(case when m.kind = 'issue' then -m.quantity else 0 end) as qty
              from inventory_movements m
             where m.org_id = s.org_id and m.item_id = s.item_id
               and m.stock_location_id = s.stock_location_id and m.status = 'posted'
               and m.moved_at >= (r.as_of - 83) and m.moved_at < (r.as_of + 1)
             group by 1) d) trend on true`,
    countJoins: sql`join demand_forecast_runs r on r.org_id = s.org_id and r.id = s.run_id`,
    builtInExpr: {
      item_name: sql`i.name`, item_code: sql`i.code`, item_id: sql`s.item_id`,
      location_code: sql`sl.code`, subsidiary_name: sql`sub.name`,
      action: sql`s.action`, quantity: sql`s.quantity::text`,
      supplier_name: sql`coalesce(pty.display_name, receipt.name)`,
      due_date: sql`s.due_date::text`, days_of_cover: sql`s.days_of_cover::text`,
      trend: sql`trend.weeks`, status: sql`s.status`,
      forecast_qty: sql`s.forecast_qty::text`, projected_supply: sql`s.projected_supply::text`,
      run_number: sql`r.number`,
    },
    sorts: {
      item: sql`i.name`, location: sql`sl.code`, subsidiary: sql`sub.name`, action: sql`s.action`,
      quantity: sql`s.quantity`, supplier: sql`coalesce(pty.display_name, receipt.name)`,
      due: sql`s.due_date`, cover: sql`s.days_of_cover`, status: sql`s.status`,
    },
    defaultSort: sql`s.due_date, i.name`,
    statusExpr: sql`s.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }, { paramKey: 'action', filterKey: 'action' }],
    where: (view, adhoc, orgId, allowed) => {
      const parts: SQL[] = [
        sql`s.org_id=${orgId}`,
        sql`and r.status='complete'`,
        subsidiaryVisibleFilter(sql`(r.parameters->>'subsidiaryId')::uuid`, allowed ?? null),
      ]
      for (const filter of view.filters) {
        if (filter.key === 'status') pushNonprofitStatusFilter(parts, filter, sql`s.status`, ['suggested', 'confirmed', 'converted', 'dismissed'])
        else if (filter.key === 'action') pushNonprofitStatusFilter(parts, { ...filter, key: 'status' }, sql`s.action`, ['buy', 'transfer'])
        else parts.push(sql`and false`)
      }
      if (adhoc.q) parts.push(sql`and (i.name ilike ${`%${adhoc.q}%`} or i.code ilike ${`%${adhoc.q}%`} or coalesce(pty.display_name, receipt.name) ilike ${`%${adhoc.q}%`})`)
      if (adhoc.filters?.status) parts.push(sql`and s.status=${adhoc.filters.status}`)
      if (adhoc.filters?.action) parts.push(sql`and s.action=${adhoc.filters.action}`)
      if (adhoc.filters?.item_id) parts.push(sql`and s.item_id=${adhoc.filters.item_id}`)
      if (adhoc.filters?.stock_location_id) parts.push(sql`and s.stock_location_id=${adhoc.filters.stock_location_id}`)
      return sql.join(parts, sql` `)
    },
    drawerParam: 'suggestion',
    basePath: '/inventory/planning',
    statusVariant: (_row, value) => value === 'converted' ? 'success' : value === 'suggested' ? 'warning' : value === 'dismissed' ? 'outline' : 'secondary',
    statusDisplayName: (storedName, translate) => {
      const fullKey = `planning.status.${storedName}`
      const out = translate(fullKey)
      return out === fullKey ? storedName : out
    },
    statusFilterKey: 'status',
  },
  inventory_movement: {
    recordType: 'inventory_movement',
    table: 'inventory_movements',
    alias: 'm',
    customFieldTable: 'items',
    customFieldAlias: 'it',
    baseJoins: INVENTORY_MOVEMENT_BASE_JOINS,
    builtInExpr: INVENTORY_MOVEMENT_BUILT_IN_EXPR,
    sorts: INVENTORY_MOVEMENT_SORTS,
    defaultSort: sql`m.moved_at`,
    statusCounts: false,
    quickFilters: [{ paramKey: 'kind', filterKey: 'kind' }],
    where: inventoryMovementScopedWhere,
    drawerParam: 'movement',
    basePath: '/inventory',
    extraSelect: sql`m.item_id`,
    rowHref: (row) => `/items?item=${row.item_id}`,
    statusVariant: (row) => row.kind === 'receipt' ? 'success' : row.kind === 'issue' ? 'warning' : 'secondary',
  },
  budget_scenario: {
    recordType: 'budget_scenario',
    table: 'budget_scenarios',
    alias: 'bs',
    baseJoins: (allowedSubsidiaryIds) => budgetBaseJoins(allowedSubsidiaryIds),
    builtInExpr: BUDGET_BUILT_IN_EXPR,
    sorts: BUDGET_SORTS,
    defaultSort: sql`bs.updated_at`,
    statusExpr: sql`bs.status`,
    quickFilters: [
      { paramKey: 'status', filterKey: 'status' },
      { paramKey: 'kind', filterKey: 'kind' },
      {
        paramKey: 'year',
        filterKey: 'fiscal_year',
        loadOptions: async (orgId, allowedSubsidiaryIds) => {
          // GROUP BY, not DISTINCT: ordering a DISTINCT by a column that only
          // appears cast in the select list is rejected by Postgres, and this
          // filter never loaded. Grouping also keeps the sort numeric — a text
          // sort would put 2030 before 999 and 9999 before 10000.
          // Same scenario-authority predicate as the list itself: years that
          // exist only in out-of-scope scenarios must not be offered.
          const visibleLineFilter = allowedSubsidiaryIds == null
            ? sql``
            : budgetScenarioScopeFilter(allowedSubsidiaryIds)
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select bs.fiscal_year::text as value, bs.fiscal_year::text as label
              from budget_scenarios bs
             where bs.org_id = ${orgId} ${visibleLineFilter}
             group by bs.fiscal_year
             order by bs.fiscal_year desc`)
          return result.rows
        },
      },
      {
        paramKey: 'book',
        filterKey: 'book_id',
        loadOptions: async (orgId) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`select id::text as value, name as label from accounting_books where org_id=${orgId} and is_active order by name`)
          return result.rows
        },
      },
    ],
    where: budgetWhere,
    drawerParam: 'budget',
    basePath: '/budgets',
    statusVariant: (row, _value, columnKey) => columnKey === 'kind'
      ? 'outline'
      : row.status === 'approved' ? 'success' : row.status === 'pending_approval' ? 'warning' : row.status === 'archived' ? 'outline' : 'secondary',
  },
  lease_agreement: {
    recordType:'lease_agreement',table:'lease_agreements',alias:'la',baseJoins:sql``,
    builtInExpr:{lease_number:sql`la.lease_number`,description:sql`la.description`,commencement_on:sql`la.commencement_on`,payment_amount:sql`la.payment_amount`,status:sql`la.status`},
    sorts:{number:sql`la.lease_number`,description:sql`la.description`,date:sql`la.commencement_on`,payment:sql`la.payment_amount`,status:sql`la.status`},
    defaultSort:sql`la.lease_number`,quickFilters:[{paramKey:'status',filterKey:'status'}],
    where:(view,adhoc,orgId,allowed)=>lifecycleWhere('la',view,adhoc,orgId,allowed),drawerParam:'lease',basePath:'/assets/leases',
  },
  financial_change: {
    recordType:'financial_change',table:'financial_changes',alias:'fc',
    baseJoins:sql`left join subsidiaries s on s.id=fc.subsidiary_id and s.org_id=fc.org_id`,
    builtInExpr:{
      operation:sql`fc.operation`,
      subject:financialChangeSubjectExpr('fc'),
      domain:sql`fc.domain`,
      subsidiary:sql`s.name`,
      reason:sql`fc.reason`,
      effective_on:sql`fc.effective_on`,
      status:sql`fc.status`,
    },
    sorts:{
      operation:sql`fc.operation`,
      subject:financialChangeSubjectExpr('fc'),
      domain:sql`fc.domain`,
      subsidiary:sql`s.name`,
      reason:sql`fc.reason`,
      date:sql`fc.effective_on`,
      status:sql`fc.status`,
    },
    defaultSort:sql`fc.effective_on`,
    quickFilters:[
      {paramKey:'queue',filterKey:'queue',defaultValue:'awaiting'},
      {paramKey:'domain',filterKey:'domain'},
      {paramKey:'status',filterKey:'status'},
    ],
    where:(view,adhoc,orgId,allowed)=>lifecycleWhere('fc',view,adhoc,orgId,allowed),
    drawerParam:'change',basePath:'/accounting/changes',
    statusVariant:(_row, value) =>
      value === 'applied' ? 'success'
      : value === 'pending' ? 'warning'
      : value === 'approved' ? 'default'
      : value === 'rejected' ? 'destructive'
      : 'outline',
  },
  contract_cost_asset: {
    recordType: 'contract_cost_asset',
    table: 'contract_cost_assets',
    alias: 'a',
    readPermission: 'contract_costs.read',
    baseJoins: CONTRACT_COST_ASSET_BASE_JOINS,
    builtInExpr: CONTRACT_COST_ASSET_BUILT_IN_EXPR,
    sorts: CONTRACT_COST_ASSET_SORTS,
    defaultSort: sql`a.capitalized_on desc`,
    statusExpr: sql`a.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: contractCostAssetWhere,
    drawerParam: 'asset',
    basePath: '/revenue/contract-costs',
    extraSelect: sql`a.currency`,
    currencyField: 'currency',
    statusVariant: (row) => row.status === 'active' ? 'success' : row.status === 'impaired' ? 'warning' : row.status === 'expensed' ? 'secondary' : 'outline',
  },
  revenue_contract: {
    recordType: 'revenue_contract',
    table: 'revenue_contracts',
    alias: 'rc',
    baseJoins: REVENUE_CONTRACT_BASE_JOINS,
    builtInExpr: REVENUE_CONTRACT_BUILT_IN_EXPR,
    sorts: REVENUE_CONTRACT_SORTS,
    defaultSort: sql`rc.contract_number`,
    statusExpr: sql`rc.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }, { paramKey: 'scope', filterKey: 'scope' }],
    where: revenueContractWhere,
    drawerParam: 'contract',
    basePath: '/revenue',
    extraSelect: sql`rc.currency`,
    currencyField: 'currency',
    statusVariant: (row) => row.status === 'active' ? 'success' : row.status === 'complete' ? 'secondary' : row.status === 'cancelled' ? 'warning' : 'outline',
  },
  equipment_unit: {
    recordType: 'equipment_unit',
    table: 'equipment_units',
    alias: 'eu',
    baseJoins: EQUIPMENT_BASE_JOINS,
    builtInExpr: EQUIPMENT_BUILT_IN_EXPR,
    sorts: EQUIPMENT_SORTS,
    defaultSort: sql`eu.unit_number`,
    statusExpr: sql`eu.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: equipmentWhere,
    drawerParam: 'equipment',
    basePath: '/assets/equipment',
    statusVariant: (row) => row.status === 'active' ? 'success' : 'secondary',
  },
  resourcing_assignment: {
    recordType: 'resourcing_assignment',
    table: 'res_assignments',
    alias: 'ra',
    customFieldTable: 'res_assignments',
    baseJoins: sql`inner join projects p on p.id=ra.project_id and p.org_id=ra.org_id
      left join parties employee on employee.id=ra.employee_party_id and employee.org_id=ra.org_id`,
    builtInExpr: {
      project_id: sql`p.name`, employee_party_id: sql`employee.display_name`, job_title: sql`ra.job_title`,
      week_start: sql`ra.week_start`, planned_hours: sql`ra.planned_hours`, booking: sql`ra.booking`,
      state: sql`ra.state`, is_billable: sql`ra.is_billable`,
    },
    sorts: {
      project: sql`p.name`, employee: sql`employee.display_name`, role: sql`ra.job_title`,
      week: sql`ra.week_start`, hours: sql`ra.planned_hours`, booking: sql`ra.booking`, state: sql`ra.state`,
    },
    defaultSort: sql`ra.week_start`,
    statusExpr: sql`ra.state`,
    quickFilters: [{ paramKey: 'status', filterKey: 'state' }],
    where: (view, adhoc, orgId, allowedSubsidiaryIds) => resourcingWhere({
      alias: 'ra',
      columns: {
        project_id: sql`ra.project_id`, employee_party_id: sql`ra.employee_party_id`, job_title: sql`ra.job_title`,
        week_start: sql`ra.week_start`, planned_hours: sql`ra.planned_hours`, booking: sql`ra.booking`,
        state: sql`ra.state`, is_billable: sql`ra.is_billable`,
      },
      dates: ['week_start'], uuids: ['project_id', 'employee_party_id'], booleans: ['is_billable'],
      searchColumns: [sql`p.name`, sql`employee.display_name`, sql`ra.job_title`], statusKey: 'state',
      subsidiary: subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null),
    }, view, adhoc, orgId),
    drawerParam: 'assignment',
    basePath: '/resourcing/assignments',
    readPermission: 'resourcing.read',
  },
  resourcing_request: {
    recordType: 'resourcing_request',
    table: 'res_requests',
    alias: 'rq',
    customFieldTable: 'res_requests',
    baseJoins: sql`inner join projects p on p.id=rq.project_id and p.org_id=rq.org_id
      left join parties employee on employee.id=rq.employee_party_id and employee.org_id=rq.org_id`,
    builtInExpr: {
      project_id: sql`p.name`, employee_party_id: sql`employee.display_name`, job_title: sql`rq.job_title`,
      first_week: sql`rq.first_week`, last_week: sql`rq.last_week`, hours_per_week: sql`rq.hours_per_week`, status: sql`rq.status`,
    },
    sorts: {
      project: sql`p.name`, employee: sql`employee.display_name`, role: sql`rq.job_title`,
      first_week: sql`rq.first_week`, last_week: sql`rq.last_week`, hours: sql`rq.hours_per_week`, status: sql`rq.status`,
    },
    defaultSort: sql`rq.first_week`,
    statusExpr: sql`rq.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId, allowedSubsidiaryIds) => resourcingWhere({
      alias: 'rq',
      columns: {
        project_id: sql`rq.project_id`, employee_party_id: sql`rq.employee_party_id`, job_title: sql`rq.job_title`,
        first_week: sql`rq.first_week`, last_week: sql`rq.last_week`, hours_per_week: sql`rq.hours_per_week`, status: sql`rq.status`,
      },
      dates: ['first_week', 'last_week'], uuids: ['project_id', 'employee_party_id'],
      searchColumns: [sql`p.name`, sql`employee.display_name`, sql`rq.job_title`], statusKey: 'status',
      subsidiary: subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null),
    }, view, adhoc, orgId),
    drawerParam: 'request',
    basePath: '/resourcing/requests',
    readPermission: 'resourcing.read',
  },
  resourcing_demand: {
    recordType: 'resourcing_demand',
    table: 'res_demand_lines',
    alias: 'dl',
    customFieldTable: 'res_demand_lines',
    baseJoins: sql`inner join departments d on d.id=dl.department_id and d.org_id=dl.org_id
      left join crm_opportunities opportunity on opportunity.id=dl.opportunity_id and opportunity.org_id=dl.org_id`,
    builtInExpr: {
      department_id: sql`d.name`, job_title: sql`dl.job_title`, first_week: sql`dl.first_week`,
      last_week: sql`dl.last_week`, hours_per_week: sql`dl.hours_per_week`, note: sql`dl.note`, opportunity_id: sql`opportunity.name`,
    },
    sorts: {
      department: sql`d.name`, role: sql`dl.job_title`, first_week: sql`dl.first_week`,
      last_week: sql`dl.last_week`, hours: sql`dl.hours_per_week`, opportunity: sql`opportunity.name`,
    },
    defaultSort: sql`dl.first_week`,
    quickFilters: [],
    where: (view, adhoc, orgId, allowedSubsidiaryIds) => resourcingWhere({
      alias: 'dl',
      columns: {
        department_id: sql`dl.department_id`, job_title: sql`dl.job_title`, first_week: sql`dl.first_week`,
        last_week: sql`dl.last_week`, hours_per_week: sql`dl.hours_per_week`, note: sql`dl.note`, opportunity_id: sql`dl.opportunity_id`,
      },
      dates: ['first_week', 'last_week'], uuids: ['department_id', 'opportunity_id'],
      searchColumns: [sql`d.name`, sql`dl.job_title`, sql`dl.note`, sql`opportunity.name`],
      subsidiary: subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds ?? null),
    }, view, adhoc, orgId),
    drawerParam: 'demand',
    basePath: '/resourcing/demand',
  },
  retainer: {
    recordType: 'retainer',
    table: 'res_retainers',
    alias: 'rt',
    customFieldTable: 'res_retainers',
    baseJoins: sql`inner join projects p on p.id=rt.project_id and p.org_id=rt.org_id
      left join parties customer on customer.id=rt.customer_party_id and customer.org_id=rt.org_id`,
    builtInExpr: {
      project_id: sql`p.name`, customer_party_id: sql`customer.display_name`, kind: sql`rt.kind`,
      total_amount: sql`rt.total_amount`, starts_on: sql`rt.starts_on`, ends_on: sql`rt.ends_on`, state: sql`rt.state`,
    },
    sorts: {
      project: sql`p.name`, customer: sql`customer.display_name`, kind: sql`rt.kind`, amount: sql`rt.total_amount`,
      start: sql`rt.starts_on`, end: sql`rt.ends_on`, state: sql`rt.state`,
    },
    defaultSort: sql`rt.starts_on`,
    statusExpr: sql`rt.state`,
    quickFilters: [{ paramKey: 'status', filterKey: 'state' }],
    where: (view, adhoc, orgId, allowedSubsidiaryIds) => resourcingWhere({
      alias: 'rt',
      columns: {
        project_id: sql`rt.project_id`, customer_party_id: sql`rt.customer_party_id`, kind: sql`rt.kind`,
        total_amount: sql`rt.total_amount`, starts_on: sql`rt.starts_on`, ends_on: sql`rt.ends_on`, state: sql`rt.state`,
      },
      dates: ['starts_on', 'ends_on'], uuids: ['project_id', 'customer_party_id'],
      searchColumns: [sql`p.name`, sql`customer.display_name`], statusKey: 'state',
      subsidiary: subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null),
    }, view, adhoc, orgId),
    drawerParam: 'retainer',
    basePath: '/resourcing/retainers',
    readPermission: 'retainers.read',
  },
  timesheet_week: {
    recordType: 'timesheet_week',
    table: (orgId) => sql`(select t.org_id, t.employee_party_id,
                    (t.worked_on - ((extract(dow from t.worked_on))::int) * interval '1 day')::date as week_start,
                    sum(t.hours) as total_hours,
                    coalesce(sum(t.hours) filter (where t.is_billable), 0) as billable_hours,
                    case
                      when bool_and(t.status='approved') then 'approved'
                      when bool_or(t.status='submitted') then 'submitted'
                      when bool_or(t.status='rejected') then 'rejected'
                      else 'draft'
                    end as status
               from time_entries t
              where t.org_id = ${orgId}
              group by t.org_id, t.employee_party_id,
                       (t.worked_on - ((extract(dow from t.worked_on))::int) * interval '1 day')::date)`,
    alias: 'tw',
    idExpr: sql`tw.employee_party_id::text || ':' || tw.week_start::text`,
    // No customFieldTable: a week is an aggregate over time_entries, not a
    // record, so it has no header of its own to extend. Tenant fields belong on
    // the LINE (time_entries) and surface as grid columns in the flyout.
    // ('timesheet_weeks' used to be named here; no such table has ever existed,
    // so any field defined against it could never be stored.)
    baseJoins: sql`left join parties employee on employee.id=tw.employee_party_id and employee.org_id=tw.org_id`,
    builtInExpr: TIMESHEET_WEEK_BUILT_IN_EXPR,
    sorts: TIMESHEET_WEEK_SORTS,
    defaultSort: sql`tw.week_start`,
    statusExpr: sql`tw.status`,
    quickFilters: [
      { paramKey: 'status', filterKey: 'status' },
      {
        paramKey: 'employee',
        filterKey: 'employee_party_id',
        loadOptions: async (orgId, allowedSubsidiaryIds) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select p.id::text as value, p.display_name as label
              from parties p
             where p.org_id=${orgId} and p.is_active
               ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds ?? null)}
               and exists (select 1 from employee_roles r where r.party_id=p.id and r.org_id=p.org_id and r.is_active)
             order by p.display_name`)
          return result.rows
        },
      },
    ],
    where: timesheetWeekWhere,
    drawerParam: 'timesheet',
    basePath: '/timesheets',
    extraSelect: sql`tw.employee_party_id, tw.week_start`,
    // No rowHref: a week opens in the flyout like every other record, keeping
    // the list's filters behind it. idExpr already yields employee:week_start.
    statusVariant: (row) => row.status === 'approved' ? 'success' : row.status === 'submitted' ? 'warning' : row.status === 'rejected' ? 'destructive' : 'secondary',
  },
  bank_reconciliation: {
    recordType: 'bank_reconciliation',
    table: 'reconciliations',
    alias: 'r',
    baseJoins: BANK_RECONCILIATION_BASE_JOINS,
    builtInExpr: BANK_RECONCILIATION_BUILT_IN_EXPR,
    sorts: BANK_RECONCILIATION_SORTS,
    defaultSort: sql`r.created_at`,
    statusExpr: sql`r.status`,
    quickFilters: [
      { paramKey: 'status', filterKey: 'status' },
      {
        paramKey: 'account',
        filterKey: 'account_id',
        loadOptions: async (orgId, allowedSubsidiaryIds) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select a.id::text as value, concat_ws(' · ', a.number, a.name) as label
              from accounts a
             where a.org_id=${orgId} and a.is_active
               ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowedSubsidiaryIds ?? null)}
               and exists (select 1 from reconciliations r where r.org_id=a.org_id and r.account_id=a.id)
             order by a.number nulls last, a.name`)
          return result.rows
        },
      },
    ],
    where: bankReconciliationWhere,
    drawerParam: 'reconciliation',
    basePath: '/banking/reconciliations',
    extraSelect: sql`r.account_id, r.currency`,
    currencyField: 'currency',
    rowHref: (row) => `/banking/${row.account_id}/reconcile/${row.id}`,
    statusVariant: (row) => row.status === 'signed_off' ? 'success' : row.status === 'balanced' ? 'warning' : 'secondary',
  },
  bank_statement: {
    recordType: 'bank_statement',
    table: 'bank_statements',
    alias: 'bs',
    baseJoins: BANK_STATEMENT_BASE_JOINS,
    builtInExpr: BANK_STATEMENT_BUILT_IN_EXPR,
    sorts: BANK_STATEMENT_SORTS,
    defaultSort: sql`bs.imported_at`,
    statusCounts: false,
    quickFilters: [
      { paramKey: 'source', filterKey: 'source' },
      {
        paramKey: 'account',
        filterKey: 'account_id',
        loadOptions: async (orgId, allowedSubsidiaryIds) => {
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select a.id::text as value, concat_ws(' · ', a.number, a.name) as label
              from accounts a
             where a.org_id=${orgId} and a.is_active
               ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowedSubsidiaryIds ?? null)}
               and exists (select 1 from bank_statements bs where bs.org_id=a.org_id and bs.account_id=a.id)
             order by a.number nulls last, a.name`)
          return result.rows
        },
      },
    ],
    where: bankStatementWhere,
    drawerParam: 'statement',
    basePath: '/banking/imports',
    extraSelect: sql`bs.account_id`,
    rowHref: (row) => `/banking/${row.account_id}?statement=${row.id}`,
    statusVariant: () => 'outline',
  },
  bank_rule: {
    recordType: 'bank_rule',
    table: 'bank_match_rules',
    alias: 'br',
    baseJoins: sql``,
    builtInExpr: BANK_RULE_BUILT_IN_EXPR,
    sorts: BANK_RULE_SORTS,
    defaultSort: sql`br.priority`,
    statusExpr: sql`br.is_active::text`,
    countFilterKey: 'is_active',
    quickFilters: [{ paramKey: 'active', filterKey: 'is_active' }],
    where: bankRuleWhere,
    drawerParam: 'rule',
    basePath: '/banking/rules',
    statusVariant: (row) => row.status === 'active' ? 'success' : 'secondary',
  },
  // Parked provider refunds and disputes awaiting an operator decision. The
  // list reads the automation ledger with the tenant pinned in its WHERE —
  // another tenant's rows never reach the queue.
  payment_dispute_review: {
    recordType: 'payment_dispute_review',
    table: 'payment_disputes',
    alias: 'pd',
    baseJoins: sql``,
    builtInExpr: PAYMENT_DISPUTE_BUILT_IN_EXPR,
    sorts: PAYMENT_DISPUTE_SORTS,
    defaultSort: sql`pd.created_at desc`,
    statusExpr: sql`pd.status`,
    countFilterKey: 'status',
    quickFilters: [
      { paramKey: 'status', filterKey: 'status' },
      { paramKey: 'kind', filterKey: 'kind' },
    ],
    where: paymentDisputeWhere,
    drawerParam: 'review',
    basePath: '/banking/psp-settlements/reviews',
    readPermission: 'banking.read',
    extraSelect: sql`pd.currency`,
    currencyField: 'currency',
    statusVariant: (row) =>
      row.status === 'posted' || row.status === 'won'
        ? 'success'
        : row.status === 'lost'
          ? 'destructive'
          : row.status === 'rejected'
            ? 'secondary'
            : 'warning',
    // Stored statuses are engine vocabulary; the queue renders them through
    // the reviews catalog. A locale without the subtree keeps the stored
    // name, never a raw message key.
    statusFilterKey: 'status',
    statusDisplayName: (storedName, translate) => {
      const fullKey = `banking.pspReviews.status.${storedName}`
      const out = translate(fullKey)
      return out === fullKey ? storedName : out
    },
  },
  // Gift cards and store credit read as one liability ledger: the code
  // renders masked, the customer join stays left (gift cards are bearer),
  // and the program join is inner (every account is issued under one).
  stored_value_account: {
    recordType: 'stored_value_account',
    table: 'stored_value_accounts',
    alias: 'sva',
    baseJoins: sql`join stored_value_programs svp on svp.org_id = sva.org_id and svp.id = sva.program_id
      left join parties cust on cust.org_id = sva.org_id and cust.id = sva.customer_party_id`,
    builtInExpr: STORED_VALUE_BUILT_IN_EXPR,
    sorts: STORED_VALUE_SORTS,
    defaultSort: sql`sva.created_at desc`,
    statusExpr: sql`sva.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: storedValueAccountWhere,
    drawerParam: 'account',
    basePath: '/stored-value',
    readPermission: 'stored_value.read',
    currencyField: 'currency',
    statusVariant: (row) => row.status === 'active' ? 'success' : row.status === 'frozen' ? 'warning' : row.status === 'expired' ? 'secondary' : 'outline',
  },
  // Funds read the fund segment's classified values, never a standalone
  // roster: the join to the org's fund segment definition is the query half
  // of the no-parallel-roster rule, and it fails closed — a fund row whose
  // segment value left the fund segment (or the org) never lists.
  fund: {
    recordType: 'fund',
    table: 'funds',
    alias: 'f',
    customFieldTable: 'funds',
    baseJoins: sql`join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
      join segment_definitions sd on sd.org_id = f.org_id and sd.id = sv.segment_id and sd.key = 'fund' and sd.source_kind = 'custom'`,
    builtInExpr: {
      code: sql`sv.code`,
      name: sql`sv.name`,
      restriction_class: sql`f.restriction_class`,
      status: sql`case when sv.is_active then 'active' else 'inactive' end`,
    },
    sorts: { code: sql`sv.code`, name: sql`sv.name`, class: sql`f.restriction_class`, status: sql`sv.is_active` },
    defaultSort: sql`sv.name`,
    statusExpr: sql`case when sv.is_active then 'active' else 'inactive' end`,
    quickFilters: [],
    where: (view, adhoc, orgId) => {
      const parts = [sql`f.org_id = ${orgId}`];
      if (adhoc.q) parts.push(sql`and (sv.code ilike ${`%${adhoc.q}%`} or sv.name ilike ${`%${adhoc.q}%`})`);
      for (const filter of view.filters) {
        if (pushCustomFieldFilter(parts, filter, 'f')) continue;
        if (filter.key === 'name' && (filter.operator === 'contains' || filter.operator === 'eq')) {
          parts.push(filter.operator === 'eq' ? sql`and sv.name = ${String(filter.value)}` : sql`and sv.name ilike ${`%${String(filter.value)}%`}`);
          continue;
        }
        parts.push(sql`and false`);
      }
      return sql.join(parts, sql` `);
    },
    drawerParam: 'fund',
    basePath: '/nonprofit/funds',
    hasInactive: true,
    statusVariant: (row) => row.status === 'active' ? 'success' : 'secondary',
  },
  // Releases join both legs' fund names in the same row scan the approval
  // adapter reads: the list can never show a release whose funds left the
  // org, because the joins — not a later check — exclude it.
  fund_release: {
    recordType: 'fund_release',
    table: 'fund_releases',
    alias: 'fr',
    customFieldTable: 'fund_releases',
    baseJoins: sql`join funds ff on ff.org_id = fr.org_id and ff.id = fr.from_fund_id
      join segment_values fsv on fsv.org_id = fr.org_id and fsv.id = fr.from_fund_id
      join funds tf on tf.org_id = fr.org_id and tf.id = fr.to_fund_id
      join segment_values tsv on tsv.org_id = fr.org_id and tsv.id = fr.to_fund_id`,
    builtInExpr: {
      release_number: sql`fr.release_number`,
      release_date: sql`fr.release_date::text`,
      from_fund: sql`case when coalesce(fsv.code, '') <> '' then fsv.code || ' · ' || fsv.name else fsv.name end`,
      to_fund: sql`case when coalesce(tsv.code, '') <> '' then tsv.code || ' · ' || tsv.name else tsv.name end`,
      amount: sql`fr.amount`,
      status: sql`fr.status`,
    },
    sorts: {
      number: sql`fr.release_number`,
      date: sql`fr.release_date`,
      from_fund: sql`fsv.code`,
      to_fund: sql`tsv.code`,
      amount: sql`fr.amount`,
      status: sql`fr.status`,
    },
    defaultSort: sql`fr.release_date desc`,
    quickFilters: [],
    where: (view, adhoc, orgId) => {
      const parts = [sql`fr.org_id = ${orgId}`];
      if (adhoc.q) parts.push(sql`and fr.release_number ilike ${`%${adhoc.q}%`}`);
      for (const filter of view.filters) {
        if (pushCustomFieldFilter(parts, filter, 'fr')) continue;
        if (filter.key === 'release_number' && (filter.operator === 'contains' || filter.operator === 'eq')) {
          parts.push(filter.operator === 'eq' ? sql`and fr.release_number = ${String(filter.value)}` : sql`and fr.release_number ilike ${`%${String(filter.value)}%`}`);
          continue;
        }
        parts.push(sql`and false`);
      }
      return sql.join(parts, sql` `);
    },
    drawerParam: 'release',
    basePath: '/nonprofit/releases',
    statusVariant: (_row, value) =>
      value === 'posted' ? 'success'
      : value === 'pending_approval' ? 'warning'
      : value === 'draft' ? 'secondary'
      : 'outline',
  },
  grant: {
    recordType: 'grant',
    table: (orgId) => sql`(
      select distinct on (g0.code) g0.*
        from grants g0
       where g0.org_id = ${orgId}
       order by g0.code, g0.version desc, g0.id desc
    )`,
    alias: 'g',
    customFieldTable: 'grants',
    baseJoins: sql`join parties p on p.org_id = g.org_id and p.id = g.sponsor_party_id
      join segment_values sv on sv.org_id = g.org_id and sv.id = g.fund_id`,
    builtInExpr: {
      code: sql`g.code`,
      name: sql`g.name`,
      sponsor: sql`p.display_name`,
      determination: sql`g.determination`,
      award_amount: sql`g.award_amount`,
      period_from: sql`g.period_from`,
      period_to: sql`g.period_to`,
      fund: sql`sv.code`,
      status: sql`g.status`,
    },
    sorts: { code: sql`g.code`, name: sql`g.name`, sponsor: sql`p.display_name`, determination: sql`g.determination`, award_amount: sql`g.award_amount`, period_from: sql`g.period_from`, period_to: sql`g.period_to`, fund: sql`sv.code`, status: sql`g.status` },
    defaultSort: sql`g.code`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId, allowedSubsidiaryIds) => {
      assertUnrestrictedScope(allowedSubsidiaryIds)
      const parts = [sql`g.org_id = ${orgId}`]
      if (adhoc.q) parts.push(sql`and (g.code ilike ${`%${adhoc.q}%`} or g.name ilike ${`%${adhoc.q}%`} or p.display_name ilike ${`%${adhoc.q}%`})`)
      if (adhoc.filters?.status) parts.push(sql`and g.status = ${adhoc.filters.status}`)
      for (const filter of view.filters) {
        if (pushCustomFieldFilter(parts, filter, 'g') || pushNonprofitStatusFilter(parts, filter, sql`g.status`, ['draft', 'awarded', 'active', 'closed_out', 'closed', 'void'])) continue
        parts.push(sql`and false`)
      }
      return sql.join(parts, sql` `)
    },
    drawerParam: 'grant',
    basePath: '/nonprofit/grants',
    statusVariant: (row) => row.status === 'active' ? 'success' : row.status === 'awarded' ? 'warning' : row.status === 'void' ? 'outline' : 'secondary',
  },
  collection_attempt: {
    // Automatic collection charges: one row per (invoice, retry position)
    // with the provider outcome, decline reason and next retry. The invoice
    // join scopes subsidiary visibility the way encumbrances do.
    recordType: 'collection_attempt',
    table: 'collection_attempts',
    alias: 'a',
    baseJoins: sql`join documents d on d.org_id = a.org_id and d.id = a.invoice_id
      join parties p on p.org_id = a.org_id and p.id = d.party_id`,
    builtInExpr: {
      invoice: sql`d.document_number`,
      customer: sql`p.display_name`,
      amount: sql`a.amount`,
      currency: sql`a.currency`,
      provider: sql`a.provider`,
      decline_code: sql`a.decline_code`,
      decline_kind: sql`a.decline_kind`,
      next_retry_on: sql`a.next_retry_on`,
      retry_position: sql`a.retry_position`,
      created_at: sql`a.created_at`,
      status: sql`a.status`,
    },
    sorts: {
      invoice: sql`d.document_number`,
      customer: sql`p.display_name`,
      amount: sql`a.amount`,
      decline_code: sql`a.decline_code`,
      decline_kind: sql`a.decline_kind`,
      next_retry_on: sql`a.next_retry_on`,
      created_at: sql`a.created_at`,
      status: sql`a.status`,
    },
    defaultSort: sql`a.created_at desc`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId, allowedSubsidiaryIds) => {
      const resolvedScope = allowedSubsidiaryIds === undefined ? new Set<string>() : allowedSubsidiaryIds, parts = [sql`a.org_id = ${orgId}`, subsidiaryVisibleFilter(sql`d.subsidiary_id`, resolvedScope)]
      if (adhoc.q) parts.push(sql`and (d.document_number ilike ${`%${adhoc.q}%`} or p.display_name ilike ${`%${adhoc.q}%`})`)
      if (adhoc.filters?.status) parts.push(sql`and a.status = ${adhoc.filters.status}`)
      for (const filter of view.filters) {
        if (pushCustomFieldFilter(parts, filter, 'a')) continue
        parts.push(sql`and false`)
      }
      return sql.join(parts, sql` `)
    },
    drawerParam: 'attempt',
    basePath: '/collections',
    statusVariant: (row) => row.status === 'succeeded' ? 'success' : row.status === 'failed' ? 'destructive' : row.status === 'processing' ? 'warning' : row.status === 'initiated' ? 'secondary' : 'outline',
  },
  tax_provider_transaction: {
    // Provider commit queue: one row per (document, provider, direction)
    // with the commit outcome. The document join scopes subsidiary
    // visibility the way collection attempts do; the tax page itself
    // already refuses entity-restricted callers.
    recordType: 'tax_provider_transaction',
    table: 'tax_provider_transactions',
    alias: 't',
    readPermission: 'reports.read',
    baseJoins: sql`join documents d on d.org_id = t.org_id and d.id = t.document_id`,
    builtInExpr: {
      document: sql`d.document_number`,
      provider: sql`t.provider`,
      kind: sql`t.kind`,
      attempts: sql`t.attempts`,
      next_attempt_at: sql`t.next_attempt_at`,
      committed_at: sql`t.committed_at`,
      created_at: sql`t.created_at`,
      status: sql`t.status`,
    },
    sorts: {
      document: sql`d.document_number`,
      provider: sql`t.provider`,
      attempts: sql`t.attempts`,
      next_attempt_at: sql`t.next_attempt_at`,
      committed_at: sql`t.committed_at`,
      created_at: sql`t.created_at`,
      status: sql`t.status`,
    },
    defaultSort: sql`t.created_at desc`,
    statusDisplayName: (storedName, translate) => {
      const fullKey = `tax.activity.status.${storedName}`
      const out = translate(fullKey)
      return out === fullKey ? storedName : out
    },
    statusFilterKey: 'status',
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId, allowedSubsidiaryIds) => {
      const resolvedScope = allowedSubsidiaryIds === undefined ? new Set<string>() : allowedSubsidiaryIds, parts = [sql`t.org_id = ${orgId}`, subsidiaryVisibleFilter(sql`d.subsidiary_id`, resolvedScope)]
      if (adhoc.q) parts.push(sql`and (d.document_number ilike ${`%${adhoc.q}%`} or t.provider ilike ${`%${adhoc.q}%`} or coalesce(t.last_error, '') ilike ${`%${adhoc.q}%`})`)
      if (adhoc.filters?.status) parts.push(sql`and t.status = ${adhoc.filters.status}`)
      for (const filter of view.filters) {
        if (pushCustomFieldFilter(parts, filter, 't')) continue
        parts.push(sql`and false`)
      }
      return sql.join(parts, sql` `)
    },
    drawerParam: 'activity',
    basePath: '/tax',
    exclusiveDrawerParams: ['filing'],
    statusVariant: (row) => row.status === 'committed' ? 'success' : row.status === 'failed' ? 'warning' : row.status === 'pending' ? 'secondary' : 'outline',
  },
  encumbrance: {
    recordType: 'encumbrance',
    table: 'encumbrances',
    alias: 'e',
    customFieldTable: 'encumbrances',
    baseJoins: sql`join accounts a on a.org_id = e.org_id and a.id = e.account_id
      join subsidiaries s on s.org_id = e.org_id and s.id = e.subsidiary_id`,
    builtInExpr: {
      number: sql`e.encumbrance_number`,
      source_kind: sql`e.source_kind`,
      account: sql`case when coalesce(a.number, '') <> '' then a.number || ' · ' || a.name else a.name end`,
      subsidiary: sql`s.name`,
      amount: sql`e.amount`,
      status: sql`e.status`,
    },
    sorts: { number: sql`e.encumbrance_number`, source_kind: sql`e.source_kind`, account: sql`a.number`, subsidiary: sql`s.name`, amount: sql`e.amount`, status: sql`e.status` },
    defaultSort: sql`e.encumbrance_number`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId, allowedSubsidiaryIds) => {
      const resolvedScope = allowedSubsidiaryIds === undefined ? new Set<string>() : allowedSubsidiaryIds, parts = [sql`e.org_id = ${orgId}`, subsidiaryVisibleFilter(sql`e.subsidiary_id`, resolvedScope)]
      if (adhoc.q) parts.push(sql`and (e.encumbrance_number ilike ${`%${adhoc.q}%`} or a.number ilike ${`%${adhoc.q}%`} or a.name ilike ${`%${adhoc.q}%`})`)
      if (adhoc.filters?.status) parts.push(sql`and e.status = ${adhoc.filters.status}`)
      for (const filter of view.filters) {
        if (pushCustomFieldFilter(parts, filter, 'e') || pushNonprofitStatusFilter(parts, filter, sql`e.status`, ['open', 'closed', 'void'])) continue
        parts.push(sql`and false`)
      }
      return sql.join(parts, sql` `)
    },
    drawerParam: 'encumbrance',
    basePath: '/nonprofit/encumbrances',
    statusVariant: (row) => row.status === 'open' ? 'success' : 'secondary',
  },
}

/**
 * Channel order subledger: every storefront order with its posting status.
 * Minor-unit totals sort exactly in SQL; the display major is derived per
 * displayed row through the shared provider-scale conversion, so zero- and
 * three-decimal shop currencies format exactly.
 */
const channelOrderBaseJoins = sql`join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
  left join documents d on d.org_id = o.org_id and d.id = o.posting_document_id`;

function channelOrderWhere(view: ListViewConfig, adhoc: EntityAdhoc, orgId: string, exceptionOnly: boolean) {
  const parts: SQL[] = [sql`o.org_id = ${orgId}`]
  if (exceptionOnly) parts.push(sql`and o.posting_status = 'exception'`)
  if (adhoc.q) {
    parts.push(sql`and (o.external_number ilike ${`%${adhoc.q}%`} or coalesce(o.customer_email, '') ilike ${`%${adhoc.q}%`} or coalesce(o.customer_name, '') ilike ${`%${adhoc.q}%`})`)
  }
  if (adhoc.filters?.status && !exceptionOnly) parts.push(sql`and o.posting_status = ${adhoc.filters.status}`)
  if (adhoc.filters?.code && exceptionOnly) parts.push(sql`and o.exception_code = ${adhoc.filters.code}`)
  if (adhoc.filters?.channel) parts.push(sql`and o.channel_id = ${adhoc.filters.channel}`)
  for (const filter of view.filters) {
    if (filter.key === 'status' && !exceptionOnly) {
      pushNonprofitStatusFilter(parts, filter, sql`o.posting_status`, ['pending', 'posted', 'summarized', 'exception', 'excluded'])
    } else if (filter.key === 'code' && exceptionOnly) {
      pushNonprofitStatusFilter(parts, filter, sql`o.exception_code`, ['unmapped_item', 'unmapped_location', 'unmapped_account', 'closed_period', 'tax_mismatch', 'currency_unsupported'])
    } else parts.push(sql`and false`)
  }
  return sql.join(parts, sql` `)
}

async function enrichChannelOrderTotals(rows: Record<string, unknown>[]): Promise<void> {
  for (const row of rows) {
    try {
      row.total = fromMinorUnits(BigInt(String(row.total_minor ?? '0')), String(row.shop_currency ?? 'USD'))
    } catch {
      row.total = '0.0000'
    }
  }
}

const CHANNEL_ORDER_SOURCES: Record<string, EntityListSource> = {
  channel_order: {
    recordType: 'channel_order', table: 'channel_orders', alias: 'o', readPermission: 'channels.read',
    baseJoins: channelOrderBaseJoins,
    builtInExpr: {
      number: sql`o.external_number`, channel: sql`c.name`, channel_id: sql`o.channel_id`,
      ordered: sql`o.ordered_at`, customer: sql`coalesce(nullif(o.customer_email, ''), o.customer_name, '')`,
      total_minor: sql`o.total_minor::text`, shop_currency: sql`o.shop_currency`,
      total: sql`o.total_minor::text`, posting_status: sql`o.posting_status`, status: sql`o.posting_status`,
      document_number: sql`d.document_number`, document_id: sql`o.posting_document_id`,
      exception_code: sql`o.exception_code`, exception_reason: sql`o.exception_reason`, exception_remedy: sql`o.exception_remedy`,
    },
    sorts: {
      number: sql`o.external_number`, channel: sql`c.name`, ordered: sql`o.ordered_at`,
      total: sql`o.total_minor`, status: sql`o.posting_status`,
    },
    defaultSort: sql`o.ordered_at`,
    statusExpr: sql`o.posting_status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
    where: (view, adhoc, orgId) => channelOrderWhere(view, adhoc, orgId, false),
    drawerParam: 'order', basePath: '/channels/orders',
    currencyField: 'shop_currency',
    statusVariant: (_row, value) =>
      value === 'posted' || value === 'summarized' ? 'success'
      : value === 'exception' ? 'destructive'
      : value === 'excluded' ? 'secondary'
      : value === 'pending' ? 'warning' : 'outline',
    statusDisplayName: (stored, translate) => translate(`channels.orderStatus.${stored}`),
    enrichRows: async (_orgId, rows) => { await enrichChannelOrderTotals(rows) },
  },
  channel_exception: {
    recordType: 'channel_exception', table: 'channel_orders', alias: 'o', readPermission: 'channels.read',
    baseJoins: channelOrderBaseJoins,
    builtInExpr: {
      number: sql`o.external_number`, channel: sql`c.name`, channel_id: sql`o.channel_id`,
      ordered: sql`o.ordered_at`, customer: sql`coalesce(nullif(o.customer_email, ''), o.customer_name, '')`,
      total_minor: sql`o.total_minor::text`, shop_currency: sql`o.shop_currency`,
      total: sql`o.total_minor::text`, status: sql`o.exception_code`,
      code: sql`o.exception_code`, reason: sql`o.exception_reason`, remedy: sql`o.exception_remedy`,
    },
    sorts: {
      number: sql`o.external_number`, channel: sql`c.name`, ordered: sql`o.ordered_at`,
      total: sql`o.total_minor`, status: sql`o.exception_code`,
    },
    defaultSort: sql`o.ordered_at`,
    statusExpr: sql`o.exception_code`,
    quickFilters: [{ paramKey: 'code', filterKey: 'code' }],
    where: (view, adhoc, orgId) => channelOrderWhere(view, adhoc, orgId, true),
    drawerParam: 'order', basePath: '/channels/exceptions',
    currencyField: 'shop_currency',
    statusVariant: () => 'destructive',
    statusDisplayName: (stored, translate) => translate(`channels.exceptionCodes.${stored}`),
    enrichRows: async (_orgId, rows) => { await enrichChannelOrderTotals(rows) },
  },
}

for (const [key, source] of Object.entries(CHANNEL_ORDER_SOURCES)) SOURCES[key] = source

export function entityListSource(recordType: string): EntityListSource | undefined {
  return SOURCES[recordType]
}

/**
 * Total ORDER BY for universal entity lists — the entity-registry twin of
 * listOrderClause. Sort keys (name, status, number) tie constantly; the
 * source row id pins every page deterministically in both directions. The
 * id expression falls back to `<alias>.id` for sources whose selected row id
 * is the table primary key.
 */
/**
 * Page scoping for a planned id list (see `orderedPageIds`): id membership
 * plus array-position ordering, so the page reads exactly the planned rows
 * in planned order. Shared by the list view and its tests — keep the shape
 * in one place.
 */
export function plannedPageClauses(ids: string[], idExpr: SQL): { where: SQL; order: SQL } {
  const array = `{${ids.join(',')}}`;
  return {
    where: sql`${idExpr} = any(${array}::uuid[])`,
    order: sql`array_position(${array}::uuid[], ${idExpr})`,
  };
}

export function entityOrderClause(
  source: Pick<EntityListSource, 'alias' | 'idExpr'>,
  orderExpr: SQL,
  dir: 'asc' | 'desc',
): SQL {
  const direction = dir === 'asc' ? sql`asc` : sql`desc`
  const rowId = source.idExpr ?? sql`${sql.raw(`"${source.alias}"`)}.id`
  return sql`${orderExpr} ${direction} nulls last, ${rowId} ${direction}`
}
