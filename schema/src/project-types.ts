import { pgTable, text, integer, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { id, orgRef, auditColumns } from "./helpers";

/**
 * Project Types — the configurable classification that drives a project's
 * profitability, invoicing, and backup behaviour. Instead of hardcoding
 * "fixed price vs T&M" everywhere, a project points at a project type whose
 * three jsonb profiles define, per tenant:
 *   • financialProfile — how each P&L measure is sourced/derived + the P&L layout
 *   • invoicingProfile — how invoices are built and revenue is recognized
 *   • backupProfile     — whether invoice backup is required and what it contains
 *
 * Built-in types (Fixed Price, Time & Materials, Cost-Plus, Not-to-Exceed) ship
 * world-class defaults that fit any project business; a tenant can add types and
 * tune every profile (e.g. to reproduce a legacy NetSuite RESTlet to the penny).
 */

/* ------------------------------------------------------------------ */
/* Profile shapes                                                     */
/* ------------------------------------------------------------------ */

/** The fixed measure vocabulary. Base measures aggregate source rows; derived
 *  measures are formulas over other measures. */
export type ProjectMeasureKey =
  | "invoiced_to_date"
  | "revenue_posted"
  | "actual_cost"
  | "labor_cost"
  | "overhead"
  | "committed_cost"
  | "billable_value"
  | "unbilled_billable"
  | "cost_budget"
  | "total_price"
  | "could_be_invoiced"
  | "total_cost"
  | "gross_profit"
  | "margin_pct"
  | "remaining_budget";

/** How `actual_cost` selects GL cost. Either raw account types or a
 *  named account-group dimension (reusing web/lib/account-groups). */
export interface CostSource {
  source: "account_types" | "account_group" | "none";
  /** For source=account_types. */
  accountTypes?: string[];
  /** For source=account_group — the account_groups.dimension, e.g. "cost_pool". */
  dimension?: string;
  /** Optional: restrict to specific group keys within the dimension. */
  groupKeys?: string[];
}

/**
 * How a project type computes its OVERHEAD allocation — each job's share of the
 * company's cost of doing business, for a fully-burdened project margin.
 *
 * IMPORTANT: overhead is a STATISTICAL / managerial number, NOT a GL posting by
 * default — the real indirect costs are already period-expensed in the ledger,
 * so posting overhead onto jobs too would double-count (see the overhead-is-
 * statistical convention). The `rate_engine` method reuses the True Cost rate
 * engine (per-department composite $/hr = overhead pool ÷ billed hours) and
 * applies it to a project's labor: Σ_dept(project hours × dept rate).
 */
export interface OverheadSource {
  method:
    | "none" //                no overhead
    | "percent_of_labor" //    laborCost × ratePercent
    | "per_labor_hour" //      project hours × ratePerHour (flat)
    | "rate_engine" //         per-department composite burden rate × project hours-by-dept (the Rassaun/Gantry model)
    | "account_group_actual"; // legacy: sum posted GL to an overhead pool tagged to the project
  /** For percent_of_labor — the percentage (25 = 25%). */
  ratePercent?: number;
  /** For per_labor_hour — the flat dollars per labor hour. */
  ratePerHour?: number;
  /** For rate_engine — how the per-department composite rate resolves + applies. */
  rateEngine?: {
    /** live = recompute from actuals via the True Cost engine; standard = use the effective-dated overhead_rates table. */
    rateSource: "live" | "standard";
    /** Which project hours the $/hr rate multiplies. */
    hoursBasis: "billed_hours" | "total_hours";
    /** Account-group dimension holding the overhead cost pools (default "overhead"). */
    dimension: string;
    /** How the rate is scoped. */
    scope: "flat" | "department" | "class";
  };
  /** For account_group_actual — the pool selection. */
  accountGroup?: { dimension: string; groupKeys?: string[] };
  /**
   * OPTIONAL GL absorption — off by default (overhead stays statistical). When
   * enabled, posts Dr overhead-applied / Cr overhead-recovery contra with the
   * over/under-recovered balance cleared to COGS, so it never double-counts.
   * For manufacturing / gov-contracting tenants only.
   */
  glAbsorption?: { enabled: boolean; appliedAccount?: string; recoveryAccount?: string };
}

export interface FinancialProfile {
  /** Posted customer docs that count as invoiced (credits subtract). */
  invoicedToDate: { docKinds: string[]; creditKinds: string[] };
  /** Posted GL cost. */
  actualCost: CostSource;
  /** Labor cost source (payroll JE vs time-entry rate vs an account group). */
  laborCost: { source: "in_actual_cost" | "time_rate" | "payroll_je" | "account_group" | "none"; dimension?: string; groupKeys?: string[] };
  /** Overhead applied to the job (statistical allocation — see OverheadSource). */
  overhead: OverheadSource;
  /** Open commitments: doc kinds whose unbilled remainder is "committed". */
  committedCost: { docKinds: string[] };
  /** Statistical billable value of all work (drives T&M price + could-be-invoiced). */
  billableValue: { includeUnbilledTime: boolean; includeUnbilledCostLines: boolean; timeRate: "bill_rate" | "cost_times_markup" };
  /** Budgeted cost. */
  costBudget: { source: "wbs_estimates" | "none" };
  /** How the contract/selling price is determined. */
  totalPrice: {
    method: "contract_field" | "billable_value" | "not_to_exceed" | "cost_plus";
    /** For cost_plus: default markup % if the project doesn't set one. */
    defaultMarkupPercent?: number;
  };
  /** Could-be-invoiced / backlog definition. */
  couldBeInvoiced: { formula: "price_minus_invoiced" | "unbilled_billable" };
  /** Which base cost measures sum into total_cost. */
  totalCost: { components: Array<"actual_cost" | "committed_cost" | "labor_cost" | "overhead"> };
  /** Ordered P&L statement lines rendered on the Financials tab. */
  layout: PnlLine[];
}

export interface PnlLine {
  measure: ProjectMeasureKey;
  /** Optional label override; falls back to a standard i18n label per measure. */
  label?: string;
  variant: "line" | "subtotal" | "total";
  /** Only shown when the measure resolves to a non-null value + this flag. */
  hideWhenZero?: boolean;
}

export interface InvoicingProfile {
  /** Billing bases the request form offers for this type. */
  allowedBases: string[]; // date_range | draw_amount | time_selection | milestone
  defaultBasis: string;
  /** How invoice lines are built. */
  lineBuilder: "tm_actual" | "milestone" | "draw" | "cost_plus";
  /** Which account invoice lines credit. */
  revenueAccount: "item_income" | "unbilled_receivable" | "fixed";
  /** Revenue recognition policy. */
  recognition: "as_invoiced" | "percent_complete_cost" | "milestone";
}

export interface BackupProfile {
  required: boolean;
  defaultBackupType: string;
  allowedBackupTypes: string[];
}

/**
 * An override layer applied on top of a project type's invoicing/backup
 * profiles. Set at the CUSTOMER level (parties.custom.invoicingPreference) and
 * the PROJECT level (projects.custom.invoicingPreference); the effective
 * preference resolves type default ← customer ← project (project wins). Every
 * field is optional — undefined/null means "inherit the lower layer".
 */
export interface InvoicingPreference {
  defaultBasis?: string | null;
  backupRequired?: boolean | null;
  backupType?: string | null;
  invoiceTemplateId?: string | null;
}

/* ------------------------------------------------------------------ */
/* Table                                                              */
/* ------------------------------------------------------------------ */

export const projectTypes = pgTable(
  "project_types",
  {
    id: id(),
    orgId: orgRef(),
    /** Stable slug, unique within an org (e.g. "time_and_materials"). */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Seeded baseline type — editable, but re-seeded if missing. */
    isBuiltIn: boolean("is_built_in").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Coarse back-compat classifier mirroring projects.billing_method. */
    billingMethod: text("billing_method", {
      enum: ["time_and_materials", "fixed_price", "cost_plus"],
    }),
    financialProfile: jsonb("financial_profile").$type<FinancialProfile>().notNull(),
    invoicingProfile: jsonb("invoicing_profile").$type<InvoicingProfile>().notNull(),
    backupProfile: jsonb("backup_profile").$type<BackupProfile>().notNull(),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [uniqueIndex("project_types_org_key").on(t.orgId, t.key)],
);

/* ------------------------------------------------------------------ */
/* Built-in defaults (world-class, any project business)              */
/* ------------------------------------------------------------------ */

const STANDARD_INVOICED = { docKinds: ["customer_invoice"], creditKinds: ["customer_credit"] };
const STANDARD_COST: CostSource = { source: "account_types", accountTypes: ["expense", "cogs", "expense_other", "expense_deferred"] };
const STANDARD_COMMITTED = { docKinds: ["purchase_order"] };
const STANDARD_BUDGET = { source: "wbs_estimates" as const };

/** Default P&L layout: revenue block → cost block → profit. */
function standardLayout(extra: PnlLine[] = []): PnlLine[] {
  return [
    { measure: "invoiced_to_date", variant: "line" },
    { measure: "could_be_invoiced", variant: "line" },
    { measure: "total_price", variant: "subtotal" },
    { measure: "actual_cost", variant: "line" },
    { measure: "committed_cost", variant: "line" },
    { measure: "total_cost", variant: "subtotal" },
    { measure: "cost_budget", variant: "line" },
    { measure: "remaining_budget", variant: "line" },
    ...extra,
    { measure: "gross_profit", variant: "total" },
  ];
}

export interface BuiltInProjectType {
  key: string;
  name: string;
  description: string;
  billingMethod: "time_and_materials" | "fixed_price" | "cost_plus" | null;
  sortOrder: number;
  financialProfile: FinancialProfile;
  invoicingProfile: InvoicingProfile;
  backupProfile: BackupProfile;
}

export const BUILTIN_PROJECT_TYPES: BuiltInProjectType[] = [
  {
    key: "time_and_materials",
    name: "Time & Materials",
    description: "Bill actual labor hours and costs (with markup) as work is performed.",
    billingMethod: "time_and_materials",
    sortOrder: 10,
    financialProfile: {
      invoicedToDate: STANDARD_INVOICED,
      actualCost: STANDARD_COST,
      laborCost: { source: "in_actual_cost" },
      overhead: { method: "none" },
      committedCost: STANDARD_COMMITTED,
      billableValue: { includeUnbilledTime: true, includeUnbilledCostLines: true, timeRate: "bill_rate" },
      costBudget: STANDARD_BUDGET,
      totalPrice: { method: "billable_value" },
      couldBeInvoiced: { formula: "unbilled_billable" },
      totalCost: { components: ["actual_cost", "committed_cost"] },
      layout: standardLayout(),
    },
    invoicingProfile: {
      allowedBases: ["time_selection", "date_range", "draw_amount"],
      defaultBasis: "time_selection",
      lineBuilder: "tm_actual",
      revenueAccount: "item_income",
      recognition: "as_invoiced",
    },
    backupProfile: { required: true, defaultBackupType: "costed_timesheets", allowedBackupTypes: ["costed_timesheets", "timesheets_purchases", "purchases", "purchases_shop_time", "quote_only", "none"] },
  },
  {
    key: "fixed_price",
    name: "Fixed Price",
    description: "A fixed contract price billed on milestones or progress draws.",
    billingMethod: "fixed_price",
    sortOrder: 20,
    financialProfile: {
      invoicedToDate: STANDARD_INVOICED,
      actualCost: STANDARD_COST,
      laborCost: { source: "in_actual_cost" },
      overhead: { method: "none" },
      committedCost: STANDARD_COMMITTED,
      billableValue: { includeUnbilledTime: true, includeUnbilledCostLines: true, timeRate: "bill_rate" },
      costBudget: STANDARD_BUDGET,
      totalPrice: { method: "contract_field" },
      couldBeInvoiced: { formula: "price_minus_invoiced" },
      totalCost: { components: ["actual_cost", "committed_cost"] },
      layout: standardLayout(),
    },
    invoicingProfile: {
      allowedBases: ["milestone", "draw_amount", "date_range"],
      defaultBasis: "milestone",
      lineBuilder: "milestone",
      revenueAccount: "unbilled_receivable",
      recognition: "percent_complete_cost",
    },
    backupProfile: { required: false, defaultBackupType: "none", allowedBackupTypes: ["none", "quote_only", "costed_timesheets"] },
  },
  {
    key: "cost_plus",
    name: "Cost-Plus",
    description: "Bill actual cost plus a fixed markup or fee.",
    billingMethod: "cost_plus",
    sortOrder: 30,
    financialProfile: {
      invoicedToDate: STANDARD_INVOICED,
      actualCost: STANDARD_COST,
      laborCost: { source: "in_actual_cost" },
      overhead: { method: "none" },
      committedCost: STANDARD_COMMITTED,
      billableValue: { includeUnbilledTime: true, includeUnbilledCostLines: true, timeRate: "cost_times_markup" },
      costBudget: STANDARD_BUDGET,
      totalPrice: { method: "cost_plus", defaultMarkupPercent: 15 },
      couldBeInvoiced: { formula: "unbilled_billable" },
      totalCost: { components: ["actual_cost", "committed_cost"] },
      layout: standardLayout(),
    },
    invoicingProfile: {
      allowedBases: ["time_selection", "date_range"],
      defaultBasis: "time_selection",
      lineBuilder: "cost_plus",
      revenueAccount: "item_income",
      recognition: "as_invoiced",
    },
    backupProfile: { required: true, defaultBackupType: "timesheets_purchases", allowedBackupTypes: ["timesheets_purchases", "costed_timesheets", "purchases", "none"] },
  },
  {
    key: "not_to_exceed",
    name: "Not-to-Exceed",
    description: "Bill time & materials up to a maximum contract cap (guaranteed maximum price).",
    billingMethod: "time_and_materials",
    sortOrder: 40,
    financialProfile: {
      invoicedToDate: STANDARD_INVOICED,
      actualCost: STANDARD_COST,
      laborCost: { source: "in_actual_cost" },
      overhead: { method: "none" },
      committedCost: STANDARD_COMMITTED,
      billableValue: { includeUnbilledTime: true, includeUnbilledCostLines: true, timeRate: "bill_rate" },
      costBudget: STANDARD_BUDGET,
      totalPrice: { method: "not_to_exceed" },
      couldBeInvoiced: { formula: "price_minus_invoiced" },
      totalCost: { components: ["actual_cost", "committed_cost"] },
      layout: standardLayout(),
    },
    invoicingProfile: {
      allowedBases: ["time_selection", "date_range"],
      defaultBasis: "time_selection",
      lineBuilder: "tm_actual",
      revenueAccount: "item_income",
      recognition: "as_invoiced",
    },
    backupProfile: { required: true, defaultBackupType: "costed_timesheets", allowedBackupTypes: ["costed_timesheets", "timesheets_purchases", "purchases", "none"] },
  },
];
