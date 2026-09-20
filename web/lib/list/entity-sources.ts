import { lifecycleWhere } from "../customization/entity-list-query/accounting-lifecycles";
import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { resolveProjectActualCosts } from '@openbooks/engine/src/projects/financials.ts'
import { cmp } from '@openbooks/engine/src/money/money.ts'
import type { ListViewConfig } from '@openbooks/customization'
import { displayOpportunityStatusName } from '../crm-status-display'
import { subsidiaryVisibleFilter } from '../subsidiaries'
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
  accountBaseJoins,
  ACCOUNT_BUILT_IN_EXPR,
  ACCOUNT_SORTS,
  ACCOUNT_STATUS_EXPR,
  accountWhere,
  JOURNAL_ENTRY_BUILT_IN_EXPR,
  JOURNAL_ENTRY_SORTS,
  JOURNAL_ENTRY_TABLE,
  journalEntryBaseJoins,
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
  budgetWhere,
  REVENUE_CONTRACT_BASE_JOINS,
  REVENUE_CONTRACT_BUILT_IN_EXPR,
  REVENUE_CONTRACT_SORTS,
  revenueContractWhere,
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
  activityWhere,
  customerWhere,
  employeeBaseJoins,
  employeeWhere,
  fixedAssetWhere,
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
  /** Where the reference column links (default: the edit drawer). Projects link
   *  to the full cockpit page instead. */
  /** The list has an `is_active` flag → show a "show inactive" toggle. */
  hasInactive?: boolean
  /** Always-selected extra fields (e.g. is_active for row styling). */
  extraSelect?: SQL
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
   * correlated per-row sum (F-t03-013). Return null to fall back to SQL
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

const SOURCES: Record<string, EntityListSource> = {
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
      const costs = await resolveProjectActualCosts(orgId, ids)
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
          // these in after, so they still win on any value collision (F-t11-003).
          const result = await db.execute<EntityQuickFilterOption & Record<string, unknown>>(sql`
            select key as value, name as label from project_types
             where org_id = ${orgId} and is_active order by name`)
          return result.rows
        },
      },
    ],
    drawerParam: 'project',
    basePath: '/projects',
    hasInactive: true,
    extraSelect: sql`p.is_active`,
    enrichRows: async (orgId, rows) => {
      const ids = rows.map((row) => String(row.id ?? '')).filter((id) => id.length > 0)
      if (ids.length === 0) return
      const costs = await resolveProjectActualCosts(orgId, ids)
      for (const row of rows) {
        const cost = costs.get(String(row.id ?? ''))
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
    baseJoins: sql``,
    builtInExpr: ITEM_BUILT_IN_EXPR,
    sorts: ITEM_SORTS,
    defaultSort: sql`i.name`,
    statusExpr: ITEM_STATUS_EXPR,
    quickFilters: [{ paramKey: 'kind', filterKey: 'kind' }],
    where: itemWhere,
    drawerParam: 'item',
    basePath: '/items',
    hasInactive: true,
    extraSelect: sql`i.is_active`,
    statusVariant: (row) => row.is_active ? 'success' : 'outline',
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
    extraSelect: sql`a.is_active`,
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
    // The WHERE never references the laterals (visibility lives in the table
    // union), so the count/status queries can skip them entirely.
    countJoins: sql``,
    builtInExpr: JOURNAL_ENTRY_BUILT_IN_EXPR,
    sorts: JOURNAL_ENTRY_SORTS,
    defaultSort: sql`e.posting_date`,
    statusExpr: sql`e.status`,
    quickFilters: [
      { paramKey: 'origin', filterKey: 'origin' },
      { paramKey: 'status', filterKey: 'status' },
    ],
    where: journalEntryWhere,
    drawerParam: 'txn',
    // Only manual-journal documents open in the journal document drawer
    // (?entry=, kind journal only). A pay_run source opens its posted entry
    // (?txn=) instead — ?entry= with a pay_run document id resolves nothing
    // and stranded the run's View-journal link (F-t08-014).
    drawerTarget: (row) => {
      if (row.source_document_id && String(row.source_document_kind ?? '') === 'journal') {
        return { param: 'entry', id: String(row.source_document_id) }
      }
      return { param: 'txn', id: String(row.id) }
    },
    basePath: '/journal',
    extraSelect: sql`source_doc.id as source_document_id, source_doc.kind as source_document_kind`,
    statusVariant: (row) => row.status === 'posted' ? 'success' : row.status === 'reversed' ? 'destructive' : 'secondary',
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
    customFieldTable: 'budget_scenarios',
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
          const visibleLineFilter = allowedSubsidiaryIds == null
            ? sql``
            : sql`and exists (
                select 1 from budget_lines bl
                 where bl.org_id = bs.org_id and bl.scenario_id = bs.id
                   ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, allowedSubsidiaryIds)}
              )`
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
    recordType:'financial_change',table:'financial_changes',alias:'fc',baseJoins:sql``,
    builtInExpr:{operation:sql`fc.operation`,domain:sql`fc.domain`,reason:sql`fc.reason`,effective_on:sql`fc.effective_on`,status:sql`fc.status`},
    sorts:{operation:sql`fc.operation`,domain:sql`fc.domain`,reason:sql`fc.reason`,date:sql`fc.effective_on`,status:sql`fc.status`},
    defaultSort:sql`fc.created_at`,quickFilters:[{paramKey:'status',filterKey:'status'}],
    where:(view,adhoc,orgId,allowed)=>lifecycleWhere('fc',view,adhoc,orgId,allowed),drawerParam:'change',basePath:'/accounting/changes',
  },
  revenue_contract: {
    recordType: 'revenue_contract',
    table: 'revenue_contracts',
    alias: 'rc',
    customFieldTable: 'revenue_contracts',
    baseJoins: REVENUE_CONTRACT_BASE_JOINS,
    builtInExpr: REVENUE_CONTRACT_BUILT_IN_EXPR,
    sorts: REVENUE_CONTRACT_SORTS,
    defaultSort: sql`rc.contract_number`,
    statusExpr: sql`rc.status`,
    quickFilters: [{ paramKey: 'status', filterKey: 'status' }],
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
    customFieldTable: 'equipment_units',
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
}

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
