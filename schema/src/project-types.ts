import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  date,
  index,
  uuid,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
 * tune every profile to match the organization's governed accounting policy.
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
 * IMPORTANT: overhead must never change the company P&L — the real indirect
 * costs are already period-expensed in the ledger, so a one-sided posting onto
 * jobs would double-count. Two application modes exist (org setting
 * `overheadApplication`): report_only (pure statistical, the default) and
 * net_zero_pair (DR overhead account tagged with the project + CR the SAME
 * account untagged — project-scoped ledger views carry burden, the account and
 * P&L net to zero; see engine/src/overhead-apply.ts). The `rate_engine` method
 * reuses the True Cost rate engine (per-department composite $/hr = overhead
 * pool ÷ billed hours) and applies it to a project's labor:
 * Σ_dept(project hours × dept rate).
 */
export interface OverheadSource {
  method:
    | "none" //                no overhead
    | "percent_of_labor" //    laborCost × ratePercent
    | "per_labor_hour" //      project hours × ratePerHour (flat)
    | "rate_engine" //         per-department composite burden rate × project hours-by-dept
    | "posted_gl_account_group"; // sum posted GL in an overhead account group tagged to the project
  /** For percent_of_labor — the percentage (25 = 25%). Persisted as a canonical decimal string; numbers remain accepted on write. */
  ratePercent?: string | number;
  /** For per_labor_hour — the flat dollars per labor hour. Persisted as a canonical decimal string; numbers remain accepted on write. */
  ratePerHour?: string | number;
  /** For rate_engine — how the per-department composite rate resolves + applies. */
  rateEngine?: {
    /** live = recompute from actuals via the True Cost engine; standard = use the effective-dated overhead_rates table. */
    rateSource: "live" | "standard";
    /** Which project hours the $/hr rate multiplies. */
    hoursBasis: "billed_hours" | "actual_hours" | "total_hours";
    /** Account-group dimension holding the overhead cost pools (default "overhead"). */
    dimension: string;
    /** How the rate is scoped. */
    scope: "flat" | "department" | "class";
  };
  /** For posted_gl_account_group — the pool selection. */
  accountGroup?: { dimension: string; groupKeys?: string[] };
}

export interface FinancialProfile {
  /** Posted customer docs that count as invoiced (credits subtract). */
  invoicedToDate: { docKinds: string[]; creditKinds: string[] };
  /** Posted GL cost. */
  actualCost: CostSource;
  /** Labor cost source (payroll JE vs time-entry rate vs an account group). */
  laborCost: { source: "in_actual_cost" | "time_rate" | "estimated_time_rate" | "payroll_je" | "account_group" | "none"; dimension?: string; groupKeys?: string[] };
  /** Overhead applied to the job (statistical allocation — see OverheadSource). */
  overhead: OverheadSource;
  /** Open commitments: eligible document kinds and lifecycle states whose
   * unbilled remainder is committed cost. Posted documents belong in actual
   * cost and are intentionally not an allowed committed-cost lifecycle.
   * A tenant may include a source system's rejected state when that source
   * continues to expose rejected documents in project forecast totals; this
   * does not approve or post the document. */
  committedCost: {
    docKinds: string[];
    statuses?: Array<"pending_approval" | "approved" | "rejected">;
  };
  /** Statistical billable value of all work (drives T&M price + could-be-invoiced). */
  billableValue: {
    includeUnbilledTime: boolean;
    includeUnbilledCostLines: boolean;
    timeRate: "bill_rate" | "cost_times_markup";
    /** Document kinds whose eligible lines contribute to selling value. */
    costSourceKinds?: string[];
    /**
     * Source-document lifecycle states whose billable lines contribute to the
     * statistical selling value. Defaults to approved + posted. A tenant may
     * include pending approval or rejected when its source ERP exposes those
     * states in project forecasts; this never approves or posts the document.
     */
    costSourceStatuses?: Array<
      "pending_approval" | "approved" | "posted" | "rejected"
    >;
  };
  /** Budgeted cost. */
  costBudget: { source: "wbs_estimates" | "none" };
  /** How the contract/selling price is determined. */
  totalPrice: {
    method: "contract_field" | "billable_value" | "not_to_exceed" | "cost_plus";
    /** For cost_plus: default markup % if the project doesn't set one. Persisted as a canonical decimal string; numbers remain accepted on write. */
    defaultMarkupPercent?: string | number;
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
  /** Operational procedure used to prepare project invoices. Standard billing
   *  uses billing requests; application_for_payment uses an SOV, cumulative
   *  applications, change orders, and retainage. */
  billingProcedure: "standard" | "application_for_payment";
  /** Billing bases the request form offers for this type. */
  /**
   * Billing bases this type offers. `field_ticket` bills a SELECTION OF SIGNED
   * FIELD TICKETS (crew tickets / billable timesheets) as the unit of work —
   * how field-service and construction crews are billed — while an office or
   * shop department on the same tenant can stay on date_range. Which bases a
   * project type offers is configuration, not an engine assumption.
   */
  allowedBases: string[]; // date_range | draw_amount | time_selection | milestone | field_ticket
  defaultBasis: string;
  /** How invoice lines are built. */
  lineBuilder: "tm_actual" | "milestone" | "draw" | "cost_plus";
  /** Which account invoice lines credit. */
  revenueAccount: "item_income" | "unbilled_receivable" | "fixed";
  /** Revenue recognition policy. */
  recognition: "as_invoiced" | "percent_complete_cost" | "milestone";
  /**
   * How the cost/labor markup is presented. "embedded" (default) folds the markup
   * into each line's rate; "lump_sum" bills the base amounts and adds ONE markup
   * line for the total markup. Same invoice total either way.
   */
  markupPresentation?: "embedded" | "lump_sum";
  /**
   * Not-to-exceed: cap the CUMULATIVE amount invoiced on the project at its
   * contract/budget value. When a request would push the running total past the
   * cap, a negative adjustment line trims it to the remaining amount (and an
   * already-exhausted budget blocks the invoice). Uncapped when omitted/false.
   */
  notToExceed?: boolean;
  /** Optional item id for the not-to-exceed adjustment line; else default income. */
  notToExceedItemId?: string | null;
  /**
   * Which posted document kinds supply rebillable job cost. Defaults to the
   * purchase-side documents (vendor_bill, expense_report, card_charge, check);
   * `project_charge` is always included. A tenant that stages priced billable
   * items on another document — e.g. sales orders for equipment or consumables —
   * adds that kind here instead of the engine assuming one company's workflow.
   */
  costSourceKinds?: string[];
  /**
   * What to do when the customer holds rate cards but none is in force on the
   * work date. `block` (the default) refuses to invoice, because billing anyway
   * silently drops every negotiated surcharge and markup. `carry_forward` bills
   * at the last card in force, which is how businesses that let a card lapse
   * while work continues actually behave. There is no safe engine default that
   * suits both, so it is the tenant's call.
   */
  rateCardLapse?: "block" | "carry_forward";
  /**
   * On a field-ticket invoice, which cost travels with the ticket.
   * `ticket_only` (the default) bills only cost the crew attached to that
   * ticket. `ticket_or_period` also sweeps in cost carrying NO ticket whose
   * date falls in the ticket's span — convenient where crews do not tag
   * materials, but it ATTRIBUTES BY GUESS: the same untagged line is eligible
   * for every ticket covering its date, so whichever invoice is cut first
   * takes it and the rest of the job is over-billed.
   */
  ticketCostScope?: "ticket_only" | "ticket_or_period";
  /**
   * How billed cost is presented. `per_source_line` shows one invoice line per
   * source line. `per_item` sums the same item into a single line — what a
   * customer usually expects to see for consumables and equipment charges,
   * where the same item is issued many times across a period.
   */
  lineGrouping?: "per_source_line" | "per_item";
  /**
   * How a percentage surcharge lands on the cent. `half_up` is ordinary money
   * rounding; `down` truncates, which never overcharges by a fraction of a cent
   * and is what some negotiated agreements specify.
   */
  surchargeRounding?: "half_up" | "down";
  /**
   * How the invoice presents what was billed. Detail is always retained on the
   * document and its backup; this only decides what the CUSTOMER is shown, which
   * is a commercial choice that varies by agreement — some want every hour and
   * every part, others want four lines.
   */
  rollup?: InvoiceRollup;
}

/**
 * Invoice rollup — summarising billed lines into the groups a customer expects.
 *
 * `none` itemises. `by_group` sums into the named groups, in order, by matching
 * each line; anything unmatched keeps its own line so nothing can be silently
 * swallowed. Groups are declared rather than hardcoded because what counts as a
 * presentation group is the tenant's language, not the engine's.
 */
export interface InvoiceRollup {
  mode: "none" | "by_group";
  groups?: InvoiceRollupGroup[];
  /** Show the collapsed detail beneath each group instead of replacing it. */
  keepDetail?: boolean;
}

export interface InvoiceRollupGroup {
  /** What the customer sees, e.g. "Labour", "Equipment", "Fuel Surcharge". */
  label: string;
  /** Item to carry the rolled-up line, so it posts to the right revenue account. */
  itemId?: string | null;
  /** Matches labor lines (billed from time) when true, cost lines when false. */
  isLabor?: boolean;
  /** Any of these item categories, matched case-insensitively. */
  itemCategories?: string[];
  /** Any of these item kinds (service, other_charge, equipment_charge…). */
  itemKinds?: string[];
  /** Any of these source document kinds (sales_order, vendor_bill…). */
  sourceKinds?: string[];
}

/**
 * A partial invoicing profile layered over the project type's. The agreement is
 * with a CUSTOMER and sometimes specific to one PROJECT, so presentation and
 * billing rules must be narrowable at both without cloning a project type per
 * customer — which is what tenants otherwise end up doing.
 */
export type InvoicingProfileOverride = Partial<InvoicingProfile>;

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
    /** Coarse project classification used by controlled billing constraints. */
    billingMethod: text("billing_method", {
      enum: ["time_and_materials", "fixed_price", "cost_plus"],
    }).notNull(),
    invoicingProfile: jsonb("invoicing_profile").$type<InvoicingProfile>().notNull(),
    backupProfile: jsonb("backup_profile").$type<BackupProfile>().notNull(),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [uniqueIndex("project_types_org_key").on(t.orgId, t.key)],
);

/**
 * Effective-dated financial-policy history. This table is authoritative for
 * project profitability calculations. Published profiles are append-only; a
 * new version closes the prior range.
 */
export const projectFinancialProfileVersions = pgTable(
  "project_financial_profile_versions",
  {
    id: id(),
    orgId: orgRef(),
    projectTypeId: uuid("project_type_id")
      .notNull()
      .references(() => projectTypes.id),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    financialProfile: jsonb("financial_profile")
      .$type<FinancialProfile>()
      .notNull(),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("project_financial_profile_versions_identity").on(
      t.projectTypeId,
      t.effectiveFrom,
    ),
    index("project_financial_profile_versions_effective").on(
      t.orgId,
      t.projectTypeId,
      t.effectiveFrom,
      t.effectiveTo,
    ),
    check(
      "project_financial_profile_versions_dates",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    check(
      "project_financial_profile_versions_profile_object",
      sql`jsonb_typeof(${t.financialProfile}) = 'object'`,
    ),
    check(
      "project_financial_profile_versions_reason",
      sql`length(btrim(${t.reason})) >= 8`,
    ),
  ],
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
  billingMethod: "time_and_materials" | "fixed_price" | "cost_plus";
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
      billingProcedure: "standard",
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
      billingProcedure: "standard",
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
      billingProcedure: "standard",
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
      billingProcedure: "standard",
      allowedBases: ["time_selection", "date_range"],
      defaultBasis: "time_selection",
      lineBuilder: "tm_actual",
      revenueAccount: "item_income",
      recognition: "as_invoiced",
    },
    backupProfile: { required: true, defaultBackupType: "costed_timesheets", allowedBackupTypes: ["costed_timesheets", "timesheets_purchases", "purchases", "none"] },
  },
  {
    key: "schedule_of_values",
    name: "Schedule of Values",
    description: "Bill a fixed-price contract through cumulative applications for payment, change orders, and retainage.",
    billingMethod: "fixed_price",
    sortOrder: 50,
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
      billingProcedure: "application_for_payment",
      allowedBases: ["draw_amount"],
      defaultBasis: "draw_amount",
      lineBuilder: "draw",
      revenueAccount: "item_income",
      recognition: "as_invoiced",
    },
    backupProfile: { required: false, defaultBackupType: "none", allowedBackupTypes: ["none", "quote_only"] },
  },
];
