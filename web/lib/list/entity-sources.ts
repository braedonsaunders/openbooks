import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { ListViewConfig } from '@openbooks/customization'
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
  PROJECT_SORTS,
  OPPORTUNITY_BASE_JOINS,
  OPPORTUNITY_BUILT_IN_EXPR,
  OPPORTUNITY_SORTS,
  FIXED_ASSET_BASE_JOINS,
  FIXED_ASSET_BUILT_IN_EXPR,
  FIXED_ASSET_SORTS,
  CRM_ACCOUNT_BASE_JOINS,
  CRM_ACCOUNT_BUILT_IN_EXPR,
  CRM_ACCOUNT_SORTS,
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
  BUDGET_BASE_JOINS,
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
  employeeWhere,
  fixedAssetWhere,
  itemWhere,
  leadWhere,
  opportunityWhere,
  projectWhere,
  prospectWhere,
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
  /** Backing table and its alias. */
  table: string
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
  statusVariant?: (row: any, value: unknown, columnKey: string) => 'default' | 'success' | 'secondary' | 'warning' | 'outline' | 'destructive'
  /** Source-specific drawer target when rows do not all use one URL param. */
  drawerTarget?: (row: any) => { param: string; id: string }
  /** Full row href for read-only aggregate rows that do not own a drawer. */
  rowHref?: (row: any) => string
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
  loadOptions?: (orgId: string) => Promise<EntityQuickFilterOption[]>
}

const SOURCES: Record<string, EntityListSource> = {
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
    quickFilters: [{ paramKey: 'status', filterKey: 'status', defaultValue: 'customer' }],
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
    baseJoins: sql``,
    builtInExpr: PARTY_BUILT_IN_EXPR,
    sorts: PARTY_SORTS,
    defaultSort: sql`p.display_name`,
    statusExpr: PARTY_ACTIVE_STATUS_EXPR,
    quickFilters: [],
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
    builtInExpr: PROJECT_BUILT_IN_EXPR,
    sorts: PROJECT_SORTS,
    defaultSort: sql`p.name`,
    where: projectWhere,
    quickFilters: [
      { paramKey: 'status', filterKey: 'status' },
      { paramKey: 'billing', filterKey: 'project_type' },
    ],
    drawerParam: 'project',
    basePath: '/projects',
    hasInactive: true,
    extraSelect: sql`p.is_active`,
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
          const result = await db.execute(sql`
            select id::text as value, name as label
              from crm_opportunity_statuses
             where org_id = ${orgId} and is_active
             order by sequence, name`) as any
          return result.rows
        },
      },
      {
        paramKey: 'owner',
        filterKey: 'owner_user_id',
        loadOptions: async (orgId) => {
          const result = await db.execute(sql`
            select id::text as value, name as label
              from users
             where org_id = ${orgId} and is_active
             order by name`) as any
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
  lead: crmAccountSource('lead', leadWhere),
  prospect: crmAccountSource('prospect', prospectWhere),
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
          const result = await db.execute(sql`select id::text as value, name as label from users where org_id=${orgId} and is_active order by name`) as any
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
    baseJoins: (_allowed, today) => accountBaseJoins(today!),
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
    drawerTarget: (row) => row.source_document_id
      ? { param: 'entry', id: String(row.source_document_id) }
      : { param: 'txn', id: String(row.id) },
    basePath: '/journal',
    extraSelect: sql`source_doc.id as source_document_id`,
    statusVariant: (row) => row.status === 'posted' ? 'success' : row.status === 'reversed' ? 'destructive' : 'secondary',
  },
  inventory_onhand: {
    recordType: 'inventory_onhand',
    table: `(select org_id, item_id, stock_location_id,
                    sum(remaining_quantity) as quantity,
                    sum(round(remaining_quantity * unit_cost, 4)) as value
               from cost_layers
              where remaining_quantity > 0
              group by org_id, item_id, stock_location_id)`,
    alias: 'oh',
    idExpr: sql`oh.item_id::text || ':' || oh.stock_location_id::text`,
    customFieldTable: 'items',
    customFieldAlias: 'it',
    baseJoins: sql`join items it on it.id=oh.item_id and it.org_id=oh.org_id join stock_locations sl on sl.id=oh.stock_location_id and sl.org_id=oh.org_id`,
    builtInExpr: INVENTORY_ONHAND_BUILT_IN_EXPR,
    sorts: INVENTORY_ONHAND_SORTS,
    defaultSort: sql`it.name`,
    statusCounts: false,
    quickFilters: [],
    where: inventoryOnhandWhere,
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
    where: inventoryMovementWhere,
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
    baseJoins: BUDGET_BASE_JOINS,
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
        loadOptions: async (orgId) => {
          // GROUP BY, not DISTINCT: ordering a DISTINCT by a column that only
          // appears cast in the select list is rejected by Postgres, and this
          // filter never loaded. Grouping also keeps the sort numeric — a text
          // sort would put 2030 before 999 and 9999 before 10000.
          const result = await db.execute(sql`
            select fiscal_year::text as value, fiscal_year::text as label
              from budget_scenarios
             where org_id = ${orgId}
             group by fiscal_year
             order by fiscal_year desc`) as any
          return result.rows
        },
      },
      {
        paramKey: 'book',
        filterKey: 'book_id',
        loadOptions: async (orgId) => {
          const result = await db.execute(sql`select id::text as value, name as label from accounting_books where org_id=${orgId} and is_active order by name`) as any
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
    table: `(select t.org_id, t.employee_party_id,
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
        loadOptions: async (orgId) => {
          const result = await db.execute(sql`
            select p.id::text as value, p.display_name as label
              from parties p
             where p.org_id=${orgId} and p.is_active
               and exists (select 1 from employee_roles r where r.party_id=p.id and r.org_id=p.org_id and r.is_active)
             order by p.display_name`) as any
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
        loadOptions: async (orgId) => {
          const result = await db.execute(sql`
            select a.id::text as value, concat_ws(' · ', a.number, a.name) as label
              from accounts a
             where a.org_id=${orgId} and a.is_active
               and exists (select 1 from reconciliations r where r.org_id=a.org_id and r.account_id=a.id)
             order by a.number nulls last, a.name`) as any
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
        loadOptions: async (orgId) => {
          const result = await db.execute(sql`
            select a.id::text as value, concat_ws(' · ', a.number, a.name) as label
              from accounts a
             where a.org_id=${orgId} and a.is_active
               and exists (select 1 from bank_statements bs where bs.org_id=a.org_id and bs.account_id=a.id)
             order by a.number nulls last, a.name`) as any
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

function crmAccountSource(
  stage: 'lead' | 'prospect',
  where: EntityListSource['where'],
): EntityListSource {
  return {
    recordType: stage,
    table: 'crm_account_profiles',
    alias: 'cp',
    idExpr: sql`p.id`,
    customFieldTable: 'parties',
    customFieldAlias: 'p',
    baseJoins: CRM_ACCOUNT_BASE_JOINS,
    builtInExpr: CRM_ACCOUNT_BUILT_IN_EXPR,
    sorts: CRM_ACCOUNT_SORTS,
    defaultSort: sql`cp.last_activity_at`,
    statusExpr: sql`cp.status_id`,
    countFilterKey: 'status_id',
    quickFilters: [
      {
        paramKey: 'status',
        filterKey: 'status_id',
        loadOptions: async (orgId) => {
          const result = await db.execute(sql`
            select id::text as value, name as label
              from crm_account_statuses
             where org_id=${orgId} and lifecycle_stage=${stage} and is_active
             order by sequence, name`) as any
          return result.rows
        },
      },
      {
        paramKey: 'owner',
        filterKey: 'owner_user_id',
        loadOptions: async (orgId) => {
          const result = await db.execute(sql`
            select id::text as value, name as label from users
             where org_id=${orgId} and is_active order by name`) as any
          return result.rows
        },
      },
    ],
    where,
    drawerParam: 'account',
    basePath: stage === 'lead' ? '/crm/leads' : '/crm/prospects',
  }
}

export function entityListSource(recordType: string): EntityListSource | undefined {
  return SOURCES[recordType]
}
