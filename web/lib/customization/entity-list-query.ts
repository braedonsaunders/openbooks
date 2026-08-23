import "server-only";

/**
 * Entity list query helpers — the non-`documents` half of the universal list.
 * Mirrors list-query.ts (which is documents-shaped) for plain entity tables
 * such as `projects`. Same contract: whitelisted column→SQL expressions,
 * whitelisted filter→SQL predicates, all parameterized (identifiers are
 * code-controlled catalog keys, never user input).
 *
 * This file is the module's public surface: it re-exports the cohesive
 * domain modules under entity-list-query/ without changing any name or
 * signature.
 */

export { type EntityAdhoc } from "./entity-list-query/adhoc"

export {
  customerBaseJoins,
  customerStatusExpr,
  CUSTOMER_BASE_JOINS,
  CUSTOMER_STATUS_EXPR,
  PARTY_ACTIVE_STATUS_EXPR,
  PARTY_BUILT_IN_EXPR,
  PARTY_SORTS,
  customerBuiltInExpr,
  CUSTOMER_BUILT_IN_EXPR,
  customerSorts,
  CUSTOMER_SORTS,
  customerWhere,
  vendorWhere,
  employeeWhere,
} from "./entity-list-query/customers"

export {
  PROJECT_BASE_JOINS,
  PROJECT_BUILT_IN_EXPR,
  PROJECT_SORTS,
  projectWhere,
} from "./entity-list-query/projects"

export {
  OPPORTUNITY_BASE_JOINS,
  OPPORTUNITY_BUILT_IN_EXPR,
  OPPORTUNITY_SORTS,
  opportunityWhere,
} from "./entity-list-query/opportunities"

export {
  CRM_ACCOUNT_BASE_JOINS,
  CRM_ACCOUNT_BUILT_IN_EXPR,
  CRM_ACCOUNT_SORTS,
  leadWhere,
  prospectWhere,
  ACTIVITY_BASE_JOINS,
  ACTIVITY_BUILT_IN_EXPR,
  ACTIVITY_SORTS,
  activityWhere,
} from "./entity-list-query/crm"

export {
  ITEM_STATUS_EXPR,
  ITEM_BUILT_IN_EXPR,
  ITEM_SORTS,
  itemWhere,
} from "./entity-list-query/items"

export {
  ACCOUNT_CLASS_EXPR,
  ACCOUNT_STATUS_EXPR,
  accountBaseJoins,
  ACCOUNT_BUILT_IN_EXPR,
  ACCOUNT_SORTS,
  accountWhere,
} from "./entity-list-query/accounts"

export {
  JOURNAL_ENTRY_BUILT_IN_EXPR,
  JOURNAL_ENTRY_SORTS,
  JOURNAL_ENTRY_TABLE,
  journalEntryCountJoins,
  journalEntryBaseJoins,
  journalEntryWhere,
} from "./entity-list-query/journal-entries"

export {
  INVENTORY_ONHAND_BUILT_IN_EXPR,
  INVENTORY_ONHAND_SORTS,
  inventoryOnhandWhere,
  INVENTORY_MOVEMENT_BASE_JOINS,
  INVENTORY_MOVEMENT_BUILT_IN_EXPR,
  INVENTORY_MOVEMENT_SORTS,
  inventoryMovementWhere,
} from "./entity-list-query/inventory"

export {
  BUDGET_BASE_JOINS,
  BUDGET_BUILT_IN_EXPR,
  BUDGET_SORTS,
  budgetWhere,
} from "./entity-list-query/budgets"

export {
  REVENUE_CONTRACT_BASE_JOINS,
  REVENUE_CONTRACT_BUILT_IN_EXPR,
  REVENUE_CONTRACT_SORTS,
  revenueContractWhere,
} from "./entity-list-query/revenue-contracts"

export {
  EQUIPMENT_BASE_JOINS,
  EQUIPMENT_BUILT_IN_EXPR,
  EQUIPMENT_SORTS,
  equipmentWhere,
} from "./entity-list-query/equipment"

export {
  TIMESHEET_WEEK_BUILT_IN_EXPR,
  TIMESHEET_WEEK_SORTS,
  timesheetWeekWhere,
} from "./entity-list-query/timesheet-weeks"

export {
  FIXED_ASSET_BASE_JOINS,
  FIXED_ASSET_BUILT_IN_EXPR,
  FIXED_ASSET_SORTS,
  fixedAssetWhere,
} from "./entity-list-query/fixed-assets"

export {
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
} from "./entity-list-query/banking"
