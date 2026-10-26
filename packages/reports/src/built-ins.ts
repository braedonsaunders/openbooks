import { PORTFOLIO_SUMMARY_REPORTS } from "./portfolio-summaries";
// Built-in report definitions — plain ReportCustomQuery plans against the
// entity catalog, seeded per-org by engine/src/provisioning/seed-reports.ts (kind =
// 'built_in'). Users can run/schedule them as-is or clone them in the studio.
//
// Year-wide windows use the `period_preset` operator with value
// 'this_fiscal_year': the web executor (web/lib/custom-reports.ts) resolves it
// to concrete gte/lte bounds against the org's fiscal calendar before the
// DB-free compiler runs, so the window honours fiscalYearStartMonth instead of
// silently reading as the calendar year. Every definition run path (interactive,
// export, drill, scheduled) funnels through that executor.

import { SALES_REPORT_ENTITIES } from "./sales-entities";
import { BANKING_REPORT_ENTITIES } from "./banking-entities";
import { REBATE_REPORT_ENTITIES } from "./rebate-entities";
import { CONTRACT_COST_REPORT_ENTITIES } from "./contract-cost-entities";
import { AMORTIZATION_REPORT_ENTITIES } from "./amortization-entities";
import { EQUITY_REPORT_ENTITIES } from "./equity-entities";
import { FIXED_ASSET_REPORT_ENTITIES } from "./fixed-asset-entities";
import { BILLING_IMPORT_REPORT_ENTITIES } from "./billing-import-entities";
import { DEMAND_REPORT_ENTITIES } from "./demand-entities";
import { defaultRowsQuery } from "./custom-query";
import { isCalendarDate } from "./fiscal-calendar";
import { BENEFITS_REPORT_ENTITIES } from "./benefits-entities";
import { RECOVERY_REPORT_ENTITIES } from "./recovery-entities";
import { SHIPPING_REPORT_ENTITIES } from "./shipping-entities";
import { HRM_REPORT_ENTITIES, REPORT_ENTITY_MAP, entityColumn } from "./entities";
import type { ReportCustomQuery, ReportFilterOperator, ReportRule } from "./types";

export type BuiltInReportUrlFilter = {
  /** Stable URL/search-view parameter name. */
  param: string;
  /** Catalog field receiving the effective filter. */
  field: string;
  op: ReportFilterOperator;
  /** Input validation and activation semantics. */
  valueKind: "text" | "uuid" | "date" | "flag";
  /** Exact value that activates a no-value flag operator (for example `1`). */
  activeValue?: string;
};

export type BuiltInReportUrlValues =
  | Readonly<Record<string, string | readonly string[] | null | undefined>>
  | { get(name: string): string | null };

export type BuiltInReportDefinition = {
  slug: string;
  name: string;
  description: string;
  query: ReportCustomQuery;
  /** Built-in-only URL controls. Kept outside persisted query JSON so screen,
   *  saved-view and export consumers can apply one authoritative filter set
   *  without changing the ReportCustomQuery storage contract. */
  urlFilters?: readonly BuiltInReportUrlFilter[];
};

/**
 * The former HRM reports page treated every HRM report entity as a separate
 * side catalog. That made the sources discoverable, but they were not actual
 * report definitions and disappeared when the page was retired.
 *
 * Materialise them as ordinary built-ins instead. They now use the same
 * definition catalog, executor, exports, schedules, permission gate and
 * feature gate as every other report. Headcount keeps its curated summary
 * definition below; every other governed source gets a practical rows-mode
 * definition generated from its declared columns and stable sort.
 */
const WORKFORCE_BUILT_IN_REPORT_DEFINITIONS: BuiltInReportDefinition[] = HRM_REPORT_ENTITIES.filter(
  (entity) => entity.key !== "hrm_headcount",
).map((entity) => ({
  slug: `workforce-${entity.key.replace(/^hrm_/, "").replaceAll("_", "-")}`,
  name: entity.label,
  description: entity.description,
  query: defaultRowsQuery(entity),
}));

const COST_OF_REVENUE_GUARD =
  "No cost of revenue recorded — classify cost-of-revenue accounts as Cost of Goods Sold in the chart of accounts";

const SAAS_METRICS_BUILT_IN_REPORTS: BuiltInReportDefinition[] = [
  {
    slug: "mrr-movements",
    name: "MRR movements",
    description: "Shows monthly MRR changes, opening and closing balances, and quick ratio.",
    query: {
      entity: "saas_metrics_facts",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "month", bin: "month" }, { column: "reporting_currency" }],
      measures: [
        { fn: "sum", column: "new_mrr", key: "new_mrr", label: "New MRR" },
        { fn: "sum", column: "expansion_mrr", key: "expansion_mrr", label: "Expansion MRR" },
        { fn: "sum", column: "contraction_mrr", key: "contraction_mrr", label: "Contraction MRR" },
        { fn: "sum", column: "churned_mrr", key: "churned_mrr", label: "Churned MRR" },
        {
          fn: "sum",
          column: "reactivation_mrr",
          key: "reactivation_mrr",
          label: "Reactivated MRR",
        },
        { fn: "opening", column: "mrr_start", key: "opening_mrr", label: "Opening MRR" },
        { fn: "closing", column: "mrr_end", key: "closing_mrr", label: "Closing MRR" },
        {
          fn: "formula",
          key: "quick_ratio",
          label: "Quick ratio",
          format: "ratio",
          undefinedLabel: "No contraction or churn in the period",
          expr: {
            op: "/",
            left: {
              op: "+",
              left: { op: "+", left: { ref: "new_mrr" }, right: { ref: "expansion_mrr" } },
              right: { ref: "reactivation_mrr" },
            },
            right: { op: "+", left: { ref: "contraction_mrr" }, right: { ref: "churned_mrr" } },
          },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "arr-summary",
    name: "ARR summary",
    description: "Shows monthly ARR as twelve times closing MRR.",
    query: {
      entity: "saas_metrics_facts",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "month", bin: "month" }, { column: "reporting_currency" }],
      measures: [
        { fn: "closing", column: "mrr_end", key: "closing_mrr", hidden: true },
        {
          fn: "formula",
          key: "arr",
          label: "Annual recurring revenue",
          format: "money",
          expr: { op: "*", left: { const: "12" }, right: { ref: "closing_mrr" } },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "revenue-churn",
    name: "Revenue and logo churn",
    description: "Compares monthly lost MRR and billing accounts with opening balances.",
    query: {
      entity: "saas_metrics_facts",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "month", bin: "month" }, { column: "reporting_currency" }],
      measures: [
        { fn: "sum", column: "churned_mrr", key: "churned_mrr", hidden: true },
        { fn: "opening", column: "mrr_start", key: "opening_mrr", hidden: true },
        { fn: "sum", column: "customers_churned", key: "customers_churned", hidden: true },
        { fn: "opening", column: "customers_start", key: "opening_customers", hidden: true },
        {
          fn: "formula",
          key: "revenue_churn",
          label: "Revenue churn",
          format: "percent",
          undefinedLabel: "No starting MRR",
          expr: { op: "/", left: { ref: "churned_mrr" }, right: { ref: "opening_mrr" } },
        },
        {
          fn: "formula",
          key: "logo_churn",
          label: "Logo churn",
          format: "percent",
          undefinedLabel: "No starting customers",
          expr: {
            op: "/",
            left: { ref: "customers_churned" },
            right: { ref: "opening_customers" },
          },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "nrr-grr",
    name: "Net and gross revenue retention",
    description: "Shows monthly net and gross revenue retention against opening MRR.",
    query: {
      entity: "saas_metrics_facts",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "month", bin: "month" }, { column: "reporting_currency" }],
      measures: [
        { fn: "opening", column: "mrr_start", key: "opening_mrr", hidden: true },
        { fn: "sum", column: "expansion_mrr", key: "expansion_mrr", hidden: true },
        { fn: "sum", column: "contraction_mrr", key: "contraction_mrr", hidden: true },
        { fn: "sum", column: "churned_mrr", key: "churned_mrr", hidden: true },
        {
          fn: "formula",
          key: "nrr",
          label: "Net revenue retention",
          format: "percent",
          undefinedLabel: "No starting MRR",
          expr: {
            op: "/",
            left: {
              op: "-",
              left: { op: "+", left: { ref: "opening_mrr" }, right: { ref: "expansion_mrr" } },
              right: { op: "+", left: { ref: "contraction_mrr" }, right: { ref: "churned_mrr" } },
            },
            right: { ref: "opening_mrr" },
          },
        },
        {
          fn: "formula",
          key: "grr",
          label: "Gross revenue retention",
          format: "percent",
          undefinedLabel: "No starting MRR",
          expr: {
            op: "/",
            left: {
              op: "-",
              left: { ref: "opening_mrr" },
              right: { op: "+", left: { ref: "contraction_mrr" }, right: { ref: "churned_mrr" } },
            },
            right: { ref: "opening_mrr" },
          },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "cohort-retention",
    name: "Cohort retention",
    description: "Shows retained MRR and billing accounts by cohort and elapsed month.",
    query: {
      entity: "saas_metrics_cohorts",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "cohort_month", bin: "month" },
        { column: "months_since_start" },
        { column: "reporting_currency" },
      ],
      measures: [
        { fn: "closing", column: "mrr", key: "cohort_mrr", hidden: true },
        { fn: "closing", column: "start_mrr", key: "start_mrr", hidden: true },
        { fn: "closing", column: "customers", key: "cohort_customers", hidden: true },
        { fn: "closing", column: "start_customers", key: "start_customers", hidden: true },
        {
          fn: "formula",
          key: "mrr_retention",
          label: "MRR retention",
          format: "percent",
          undefinedLabel: "No starting cohort MRR",
          expr: { op: "/", left: { ref: "cohort_mrr" }, right: { ref: "start_mrr" } },
        },
        {
          fn: "formula",
          key: "customer_retention",
          label: "Customer retention",
          format: "percent",
          undefinedLabel: "No starting cohort customers",
          expr: { op: "/", left: { ref: "cohort_customers" }, right: { ref: "start_customers" } },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "arpa-ltv",
    name: "ARPA and lifetime value",
    description:
      "Shows 12-month average revenue, churn, gross margin, and lifetime value per account.",
    query: {
      entity: "saas_metrics_facts",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "reporting_currency" }],
      measures: [
        { fn: "closing", column: "mrr_end", key: "closing_mrr", hidden: true },
        { fn: "closing", column: "customers_end", key: "closing_customers", hidden: true },
        { fn: "sum", column: "churned_mrr", key: "churned_mrr", hidden: true },
        { fn: "sum", column: "mrr_at_risk", key: "mrr_at_risk", hidden: true },
        { fn: "sum", column: "gl_revenue", key: "gl_revenue", hidden: true },
        { fn: "sum", column: "gl_cogs", key: "gl_cogs", hidden: true },
        {
          fn: "formula",
          key: "arpa",
          label: "Average revenue per account",
          format: "money",
          undefinedLabel: "No customers at period end",
          expr: { op: "/", left: { ref: "closing_mrr" }, right: { ref: "closing_customers" } },
        },
        {
          fn: "formula",
          key: "average_monthly_revenue_churn",
          label: "Average monthly revenue churn",
          hidden: true,
          format: "ratio",
          undefinedLabel: "No MRR at risk",
          expr: { op: "/", left: { ref: "churned_mrr" }, right: { ref: "mrr_at_risk" } },
        },
        {
          fn: "formula",
          key: "gross_margin",
          label: "Gross margin",
          hidden: true,
          format: "percent",
          undefinedLabel: "No revenue in the period",
          guards: [{ measure: "gl_cogs", when: "zero", label: COST_OF_REVENUE_GUARD }],
          expr: {
            op: "/",
            left: { op: "-", left: { ref: "gl_revenue" }, right: { ref: "gl_cogs" } },
            right: { ref: "gl_revenue" },
          },
        },
        {
          fn: "formula",
          key: "ltv",
          label: "Lifetime value",
          format: "money",
          undefinedLabel: "No revenue churn in the period",
          guards: [{ measure: "gl_cogs", when: "zero", label: COST_OF_REVENUE_GUARD }],
          expr: {
            op: "/",
            left: { op: "*", left: { ref: "arpa" }, right: { ref: "gross_margin" } },
            right: { ref: "average_monthly_revenue_churn" },
          },
        },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "month", op: "period_preset", value: "trailing_12_months" }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "gross-margin",
    name: "Gross margin",
    description: "Compares monthly revenue and cost of revenue to show gross margin.",
    query: {
      entity: "saas_metrics_facts",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "month", bin: "month" }, { column: "reporting_currency" }],
      measures: [
        { fn: "sum", column: "gl_revenue", key: "gl_revenue", hidden: true },
        { fn: "sum", column: "gl_cogs", key: "gl_cogs", hidden: true },
        {
          fn: "formula",
          key: "gross_margin",
          label: "Gross margin",
          format: "percent",
          undefinedLabel: "No revenue in the period",
          guards: [{ measure: "gl_cogs", when: "zero", label: COST_OF_REVENUE_GUARD }],
          expr: {
            op: "/",
            left: { op: "-", left: { ref: "gl_revenue" }, right: { ref: "gl_cogs" } },
            right: { ref: "gl_revenue" },
          },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "deferred-waterfall",
    name: "Deferred revenue waterfall",
    description:
      "Shows future recognition of active deferred revenue by month, account, and currency.",
    query: {
      entity: "deferred_revenue_runoff",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "month", bin: "month" },
        { column: "deferred_account" },
        { column: "currency" },
      ],
      measures: [{ fn: "sum", column: "amount", label: "Planned recognition" }],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "bookings-billings-revenue",
    name: "Bookings, billings and revenue",
    description: "Shows monthly bookings, billings, and revenue.",
    query: {
      entity: "saas_metrics_facts",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "month", bin: "month" }, { column: "reporting_currency" }],
      measures: [
        { fn: "sum", column: "bookings", label: "Bookings" },
        { fn: "sum", column: "billings", label: "Billings" },
        { fn: "sum", column: "recognized_revenue", label: "Recognised revenue" },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
];

/** Fixed-asset built-ins: the register, roll-forward and forecast, and the depth workspaces' queues. */
const fixedAssetEntity = (key: string) => {
  const entity = FIXED_ASSET_REPORT_ENTITIES.find((candidate) => candidate.key === key);
  if (!entity) throw new Error(`fixed-asset report entity ${key} is not registered`);
  return entity;
};
const FIXED_ASSET_REPORTS: BuiltInReportDefinition[] = [
  {
    slug: "fixed-asset-register",
    name: "Fixed asset register by book",
    description: "Assets by status, book and category, including construction in progress.",
    query: defaultRowsQuery(fixedAssetEntity("fixed_asset_register")),
  },
  {
    slug: "fixed-asset-roll-forward",
    name: "Fixed asset roll-forward",
    description: "Opening, additions, transfers, disposals and closing asset cost by book.",
    query: {
      entity: "fixed_asset_rollforward",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "book" }, { column: "category" }, { column: "base_currency" }],
      measures: [
        { fn: "opening", column: "cost_opening", key: "cost_opening", label: "Opening cost" },
        { fn: "sum", column: "additions", key: "additions", label: "Additions" },
        {
          fn: "sum",
          column: "transfers",
          key: "transfers",
          label: "Transfers and partial disposals",
        },
        { fn: "sum", column: "disposals", key: "disposals", label: "Disposals" },
        { fn: "sum", column: "capitalized", key: "capitalized", label: "Construction capitalized" },
        { fn: "closing", column: "cost_closing", key: "cost_closing", label: "Closing cost" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "month", op: "period_preset", value: "this_fiscal_year" }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "depreciation-roll-forward",
    name: "Depreciation roll-forward",
    description:
      "Opening, charge, remeasurement, disposals and closing accumulated depreciation by book.",
    query: {
      entity: "fixed_asset_rollforward",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "book" }, { column: "category" }, { column: "base_currency" }],
      measures: [
        {
          fn: "opening",
          column: "accumulated_opening",
          key: "accumulated_opening",
          label: "Opening accumulated depreciation",
        },
        { fn: "sum", column: "depreciation", key: "depreciation", label: "Depreciation" },
        {
          fn: "sum",
          column: "remeasurement",
          key: "remeasurement",
          label: "Impairment and revaluation",
        },
        {
          fn: "sum",
          column: "accumulated_other",
          key: "accumulated_other",
          label: "Disposals and transfers",
        },
        {
          fn: "closing",
          column: "accumulated_closing",
          key: "accumulated_closing",
          label: "Closing accumulated depreciation",
        },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "month", op: "period_preset", value: "this_fiscal_year" }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "depreciation-forecast",
    name: "Depreciation forecast",
    description: "Planned depreciation not yet posted, by book and month.",
    query: {
      entity: "fixed_asset_depreciation_forecast",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "book" },
        { column: "period_ends_on", bin: "month" },
        { column: "base_currency" },
      ],
      measures: [{ fn: "sum", column: "planned", key: "planned", label: "Planned depreciation" }],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "asset-proposals-pending",
    name: "Asset proposals pending",
    description: "Purchase lines awaiting a capitalization decision.",
    query: {
      ...defaultRowsQuery(fixedAssetEntity("asset_proposals")),
      filters: { combinator: "and", rules: [{ field: "status", op: "eq", value: "pending" }] },
    },
  },
  {
    slug: "asset-maintenance-due",
    name: "Asset maintenance due",
    description: "Maintenance schedules due or overdue on the report date.",
    query: {
      ...defaultRowsQuery(fixedAssetEntity("asset_maintenance_due")),
      filters: {
        combinator: "and",
        rules: [{ field: "standing", op: "in", value: ["due", "overdue"] }],
      },
    },
  },
  {
    slug: "insured-value-vs-net-book-value",
    name: "Insured value vs net book value",
    description: "Covered assets with insured value, net book value and the gap between them.",
    query: defaultRowsQuery(fixedAssetEntity("asset_insured_values")),
  },
  {
    slug: "construction-in-progress-costs",
    name: "Construction-in-progress costs",
    description: "GL lines linked to construction in progress, by record and account.",
    query: defaultRowsQuery(fixedAssetEntity("asset_cip_costs")),
  },
];

/** Service dispatch analysis. Rates are formula measures over counted
 *  components, so the engine divides exactly and names an empty denominator
 *  instead of printing zero. */
const SERVICE_BUILT_IN_REPORTS: BuiltInReportDefinition[] = [
  {
    slug: "service-jobs-by-status",
    name: "Service jobs by status and age",
    description:
      "Service jobs by status, open-job age and priority, with average and oldest age in days.",
    query: {
      entity: "service_jobs_by_status",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "status" }, { column: "age_bucket" }, { column: "priority" }],
      measures: [
        { fn: "count", key: "jobs", label: "Jobs" },
        { fn: "avg", column: "age_days", key: "average_age", label: "Average age (days)" },
        { fn: "max", column: "age_days", key: "oldest_age", label: "Oldest (days)" },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "service-technician-utilization",
    name: "Technician utilization",
    description: "Booked service visit hours against recorded labor hours, by technician and week.",
    query: {
      entity: "service_technician_utilization",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "technician" }, { column: "work_date", bin: "week" }],
      measures: [
        { fn: "sum", column: "booked_hours", key: "booked_hours", label: "Booked hours" },
        { fn: "sum", column: "worked_hours", key: "worked_hours", label: "Recorded hours" },
        { fn: "sum", column: "booked_visits", key: "booked_visits", label: "Booked visits" },
        {
          fn: "formula",
          key: "recorded_to_booked",
          label: "Recorded to booked",
          format: "percent",
          undefinedLabel: "No booked hours",
          guards: [{ measure: "booked_hours", when: "zero", label: "No booked hours" }],
          expr: { op: "/", left: { ref: "worked_hours" }, right: { ref: "booked_hours" } },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "service-first-time-fix",
    name: "First-time fix rate",
    description: "Completed service jobs fixed on their first visit, by month of completion.",
    query: {
      entity: "service_first_time_fix",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "completed_on", bin: "month" }],
      measures: [
        { fn: "count", key: "jobs", label: "Completed jobs" },
        {
          fn: "count",
          key: "fixed",
          label: "Fixed first time",
          filter: { combinator: "and", rules: [{ field: "first_time_fix", op: "is_true" }] },
        },
        {
          fn: "avg",
          column: "completed_visits",
          key: "average_visits",
          label: "Average visits per job",
        },
        {
          fn: "formula",
          key: "first_time_fix_rate",
          label: "First-time fix rate",
          format: "percent",
          undefinedLabel: "No completed jobs",
          guards: [{ measure: "jobs", when: "zero", label: "No completed jobs" }],
          expr: { op: "/", left: { ref: "fixed" }, right: { ref: "jobs" } },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "service-quote-win-rate",
    name: "Service quote win rate",
    description: "Quotes sent, accepted and declined by month, with accepted value and win rate.",
    query: {
      entity: "service_quote_win_rate",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "sent_on", bin: "month" }, { column: "currency" }],
      measures: [
        { fn: "count", key: "sent", label: "Quotes sent" },
        {
          fn: "count",
          key: "accepted",
          label: "Accepted",
          filter: { combinator: "and", rules: [{ field: "status", op: "eq", value: "accepted" }] },
        },
        {
          fn: "count",
          key: "declined",
          label: "Declined",
          filter: { combinator: "and", rules: [{ field: "status", op: "eq", value: "declined" }] },
        },
        {
          fn: "count",
          key: "decided",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [{ field: "status", op: "in", value: ["accepted", "declined"] }],
          },
        },
        { fn: "sum", column: "accepted_total", key: "accepted_value", label: "Accepted value" },
        {
          fn: "formula",
          key: "win_rate",
          label: "Win rate",
          format: "percent",
          undefinedLabel: "No decided quotes",
          guards: [{ measure: "decided", when: "zero", label: "No decided quotes" }],
          expr: { op: "/", left: { ref: "accepted" }, right: { ref: "decided" } },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "service-revenue-per-job",
    name: "Service revenue per job",
    description:
      "Invoiced revenue and average revenue per completed billable job, by month and currency.",
    query: {
      entity: "service_revenue_per_job",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "completed_on", bin: "month" }, { column: "currency" }],
      measures: [
        { fn: "count", key: "jobs", label: "Completed jobs" },
        { fn: "sum", column: "invoiced_revenue", key: "revenue", label: "Invoiced revenue" },
        {
          fn: "formula",
          key: "revenue_per_job",
          label: "Revenue per job",
          format: "money",
          undefinedLabel: "No completed jobs",
          guards: [{ measure: "jobs", when: "zero", label: "No completed jobs" }],
          expr: { op: "/", left: { ref: "revenue" }, right: { ref: "jobs" } },
        },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "billing_mode", op: "in", value: ["per_job", "per_visit"] }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
];

const REGISTER = EQUITY_REPORT_ENTITIES.find(
  (entity) => entity.key === "equity_securities_register",
)!;

export const BUILT_IN_REPORT_DEFINITIONS: BuiltInReportDefinition[] = [
  ...FIXED_ASSET_REPORTS,
  ...PORTFOLIO_SUMMARY_REPORTS,
  ...SALES_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  ...BANKING_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  ...REBATE_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  ...CONTRACT_COST_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  ...AMORTIZATION_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  ...EQUITY_REPORT_ENTITIES.filter((entity) => entity.key !== REGISTER.key).map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  {
    // The register as of a date: every security issued by then, with the
    // status and quantity it holds on that date beside its terms, so voided,
    // converted and exercised securities read as such.
    slug: "equity-securities-register",
    name: REGISTER.label,
    description: REGISTER.description,
    query: {
      ...defaultRowsQuery(REGISTER),
      columns: [
        "issue_date",
        "security_number",
        "security_kind",
        "holder",
        "share_class",
        "status",
        "quantity_issued",
        "quantity_outstanding",
        "price_per_share",
        "currency",
      ],
    },
  },
  {
    slug: "equity-stock-compensation-schedule",
    name: "Stock compensation expense schedule",
    description: "Stock compensation posted by period and currency, from the posted runs.",
    query: {
      entity: "equity_compensation_run_lines",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "through_date", bin: "month" }, { column: "currency" }],
      measures: [{ fn: "sum", column: "period", label: "Posted" }],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    // The position ledger is a point-in-time source: the viewer's as-of date
    // (today when none is chosen) bounds the movements summed per class,
    // position and holder, and those sums are the cap table on that date.
    // Positions fully exercised, forfeited or transferred before the date sum
    // to zero and are omitted; lines read by class, then shares before awards
    // before the pool, then holder.
    slug: "equity-cap-table",
    name: "Cap table as of a date",
    description: "Outstanding and fully diluted shares by class and holder on the chosen date.",
    query: {
      entity: "equity_cap_table_positions",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "share_class" }, { column: "position_kind" }, { column: "holder" }],
      measures: [
        { fn: "sum", column: "outstanding", label: "Outstanding shares" },
        { fn: "sum", column: "as_converted_outstanding", label: "Outstanding, as converted" },
        { fn: "sum", column: "awards_outstanding", label: "Awards outstanding" },
        { fn: "sum", column: "pool_available", label: "Pool available" },
        { fn: "sum", column: "fully_diluted", label: "Fully diluted" },
      ],
      sorts: [
        { column: "share_class", direction: "asc" },
        { column: "position_kind", direction: "asc" },
        { column: "holder", direction: "asc" },
      ],
      omitZeroRows: true,
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "prepaid-expense-waterfall",
    name: "Prepaid expense waterfall",
    description: "Amortized and scheduled prepaid expense by month, deferral account and currency.",
    query: {
      entity: "prepaid_amortization_plan",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "month", bin: "month" },
        { column: "deferral_account" },
        { column: "currency" },
      ],
      measures: [
        { fn: "sum", column: "amortized", label: "Amortized" },
        { fn: "sum", column: "scheduled", label: "Scheduled" },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "prepaid-expense-reconciliation",
    name: "Prepaid expense reconciliation",
    description:
      "Deferral ledger balances against unamortized schedule balances, by account and book.",
    query: {
      entity: "prepaid_amortization_reconciliation",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "deferral_account" },
        { column: "subsidiary" },
        { column: "book" },
        { column: "currency" },
      ],
      measures: [
        { fn: "sum", column: "ledger", label: "General ledger" },
        { fn: "sum", column: "subledger", label: "Schedules" },
        { fn: "sum", column: "difference", label: "Difference" },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  ...BILLING_IMPORT_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  ...RECOVERY_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  {
    slug: "collection-recovery-rate",
    name: "Collection recovery rate",
    description:
      "Recovered invoices and revenue, and recovery rate by decline class, provider and month.",
    query: {
      entity: "collection_recovery",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "first_decline_class" },
        { column: "provider" },
        { column: "first_attempt_day", bin: "month" },
        { column: "currency" },
      ],
      measures: [
        { fn: "count", key: "charged_invoices", label: "Charged invoices" },
        { fn: "sum", column: "recovered", key: "recovered_invoices", label: "Recovered invoices" },
        {
          fn: "sum",
          column: "recovered_amount",
          key: "recovered_amount",
          label: "Recovered revenue",
        },
        {
          fn: "formula",
          key: "recovery_rate",
          label: "Recovery rate",
          format: "percent",
          undefinedLabel: "No failed invoices",
          expr: {
            op: "/",
            left: { ref: "recovered_invoices" },
            right: { ref: "charged_invoices" },
          },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "stored-value-liability-roll-forward",
    name: "Stored-value liability roll-forward",
    description:
      "Gift-card and store-credit issued, redeemed, expired and adjusted, with closing liability.",
    query: {
      entity: "stored_value_movements",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "program" },
        { column: "entered_on", bin: "month" },
        { column: "currency" },
      ],
      measures: [
        {
          fn: "sum",
          column: "amount",
          key: "issued",
          label: "Issued",
          filter: { combinator: "and", rules: [{ field: "kind", op: "eq", value: "issue" }] },
        },
        {
          fn: "sum",
          column: "amount",
          key: "redeemed",
          label: "Redeemed",
          filter: { combinator: "and", rules: [{ field: "kind", op: "eq", value: "redeem" }] },
        },
        {
          fn: "sum",
          column: "amount",
          key: "breakage",
          label: "Breakage",
          filter: { combinator: "and", rules: [{ field: "kind", op: "eq", value: "breakage" }] },
        },
        {
          fn: "sum",
          column: "amount",
          key: "expired",
          label: "Expired",
          filter: { combinator: "and", rules: [{ field: "kind", op: "eq", value: "expire" }] },
        },
        {
          fn: "sum",
          column: "amount",
          key: "adjustments",
          label: "Adjustments",
          filter: { combinator: "and", rules: [{ field: "kind", op: "eq", value: "adjust" }] },
        },
        { fn: "closing", column: "balance_after", label: "Closing liability" },
        { fn: "count", label: "Movements" },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "stored-value-unclaimed-property",
    name: "Stored-value unclaimed property",
    description: "Open gift-card and store-credit balances by customer region, for escheat review.",
    query: {
      entity: "stored_value_balances",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "customer_region" },
        { column: "last_activity_on", bin: "month" },
        { column: "currency" },
      ],
      measures: [
        { fn: "sum", column: "balance", label: "Open balance" },
        { fn: "count", label: "Accounts" },
        { fn: "min", column: "last_activity_on", label: "Oldest activity" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "status", op: "in", value: ["active", "frozen"] }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "register-z-report-history",
    name: "Register Z report history",
    description:
      "Closed register sessions with sales, refunds, expected and counted cash and over/short.",
    query: {
      entity: "pos_sessions",
      mode: "rows",
      columns: [
        "business_date",
        "register",
        "session_number",
        "opened_by",
        "closed_by",
        "sale_count",
        "sales_total",
        "refunds_total",
        "opening_float",
        "expected_cash",
        "counted_cash",
        "over_short",
        "currency",
      ],
      breakouts: [],
      measures: [],
      filters: { combinator: "and", rules: [{ field: "status", op: "eq", value: "closed" }] },
      groupBy: null,
      sorts: [{ column: "business_date", direction: "desc" }],
      limit: 10000,
    },
  },
  {
    slug: "register-sales-by-register-and-cashier",
    name: "Sales by register and cashier",
    description: "Posted register sales, refunds and net sales by register and cashier.",
    query: {
      entity: "pos_transactions",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "register" }, { column: "cashier" }, { column: "currency" }],
      measures: [
        {
          fn: "sum",
          column: "total",
          key: "sales",
          label: "Sales",
          filter: { combinator: "and", rules: [{ field: "kind", op: "eq", value: "sale" }] },
        },
        {
          fn: "sum",
          column: "total",
          key: "refunds",
          label: "Refunds",
          filter: { combinator: "and", rules: [{ field: "kind", op: "eq", value: "refund" }] },
        },
        { fn: "sum", column: "net_sales", key: "net_sales", label: "Net sales" },
        { fn: "count", key: "transactions", label: "Transactions" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "document_status", op: "eq", value: "posted" }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  ...SERVICE_BUILT_IN_REPORTS,
  {
    slug: "order-margin-by-channel",
    name: "Order margin by channel",
    description:
      "Contribution margin by channel and month: CM1, CM2 and CM3, with the margin ratio.",
    query: {
      entity: "order_economics",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "channel" },
        { column: "ordered_day", bin: "month" },
        { column: "currency" },
      ],
      measures: [
        {
          fn: "sum",
          column: "amount",
          key: "revenue",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [{ field: "component", op: "in", value: ["net_revenue", "discount"] }],
          },
        },
        {
          fn: "sum",
          column: "amount",
          key: "goods",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [{ field: "component", op: "in", value: ["cogs", "returns", "restocking_fee"] }],
          },
        },
        {
          fn: "sum",
          column: "amount",
          key: "fees",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [
              {
                field: "component",
                op: "in",
                value: [
                  "processor_fee",
                  "shipping_label",
                  "marketplace_fee",
                  "stored_value_funding",
                ],
              },
            ],
          },
        },
        {
          fn: "sum",
          column: "amount",
          key: "marketing",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [{ field: "component", op: "eq", value: "ad_spend" }],
          },
        },
        {
          fn: "formula",
          key: "revenue_shown",
          label: "Revenue",
          format: "money",
          expr: { ref: "revenue" },
        },
        {
          fn: "formula",
          key: "cm1",
          label: "CM1 after cost of goods",
          format: "money",
          expr: { op: "+", left: { ref: "revenue" }, right: { ref: "goods" } },
        },
        {
          fn: "formula",
          key: "cm2",
          label: "CM2 after fulfilment and fees",
          format: "money",
          expr: { op: "+", left: { ref: "cm1" }, right: { ref: "fees" } },
        },
        {
          fn: "formula",
          key: "cm3",
          label: "CM3 after marketing",
          format: "money",
          expr: { op: "+", left: { ref: "cm2" }, right: { ref: "marketing" } },
        },
        {
          fn: "formula",
          key: "margin_pct",
          label: "CM2 margin",
          format: "percent",
          undefinedLabel: "No revenue in the period",
          guards: [{ measure: "revenue", when: "zero", label: "No revenue in the period" }],
          expr: { op: "/", left: { ref: "cm2" }, right: { ref: "revenue" } },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "order-margin-by-sku",
    name: "Order margin by item",
    description: "Contribution margin by item and channel, with the same CM1, CM2 and CM3 ladder.",
    query: {
      entity: "order_economics",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "sku" }, { column: "channel" }, { column: "currency" }],
      measures: [
        {
          fn: "sum",
          column: "amount",
          key: "revenue",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [{ field: "component", op: "in", value: ["net_revenue", "discount"] }],
          },
        },
        {
          fn: "sum",
          column: "amount",
          key: "goods",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [{ field: "component", op: "in", value: ["cogs", "returns", "restocking_fee"] }],
          },
        },
        {
          fn: "sum",
          column: "amount",
          key: "fees",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [
              {
                field: "component",
                op: "in",
                value: [
                  "processor_fee",
                  "shipping_label",
                  "marketplace_fee",
                  "stored_value_funding",
                ],
              },
            ],
          },
        },
        {
          fn: "sum",
          column: "amount",
          key: "marketing",
          hidden: true,
          filter: {
            combinator: "and",
            rules: [{ field: "component", op: "eq", value: "ad_spend" }],
          },
        },
        {
          fn: "formula",
          key: "revenue_shown",
          label: "Revenue",
          format: "money",
          expr: { ref: "revenue" },
        },
        {
          fn: "formula",
          key: "cm1",
          label: "CM1 after cost of goods",
          format: "money",
          expr: { op: "+", left: { ref: "revenue" }, right: { ref: "goods" } },
        },
        {
          fn: "formula",
          key: "cm2",
          label: "CM2 after fulfilment and fees",
          format: "money",
          expr: { op: "+", left: { ref: "cm1" }, right: { ref: "fees" } },
        },
        {
          fn: "formula",
          key: "cm3",
          label: "CM3 after marketing",
          format: "money",
          expr: { op: "+", left: { ref: "cm2" }, right: { ref: "marketing" } },
        },
        {
          fn: "formula",
          key: "margin_pct",
          label: "CM2 margin",
          format: "percent",
          undefinedLabel: "No revenue in the period",
          guards: [{ measure: "revenue", when: "zero", label: "No revenue in the period" }],
          expr: { op: "/", left: { ref: "cm2" }, right: { ref: "revenue" } },
        },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  ...DEMAND_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  })),
  {
    slug: "ap-aging-by-vendor",
    name: "AP aging by vendor",
    description: "Open payable balances per vendor, by due month.",
    query: {
      entity: "ledger_lines",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "party_name" }, { column: "due_date", bin: "month" }],
      measures: [
        { fn: "sum", column: "open_amount", label: "Open amount (base)" },
        { fn: "count", label: "Open lines" },
      ],
      filters: {
        combinator: "and",
        rules: [
          { field: "account_type", op: "eq", value: "liability_payable" },
          { field: "has_open_balance", op: "is_true" },
          { field: "entry_status", op: "eq", value: "posted" },
        ],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "open-ar-by-customer",
    name: "Open AR by customer",
    description: "Outstanding receivable balances per customer.",
    query: {
      entity: "ledger_lines",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "party_name" }],
      measures: [
        { fn: "sum", column: "open_amount", label: "Open balance (base)" },
        { fn: "count", label: "Open lines" },
        { fn: "min", column: "due_date", label: "Oldest due date" },
      ],
      filters: {
        combinator: "and",
        rules: [
          { field: "account_type", op: "eq", value: "asset_receivable" },
          { field: "has_open_balance", op: "is_true" },
          { field: "entry_status", op: "eq", value: "posted" },
        ],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "gl-activity-by-account-fy",
    name: "GL activity by account",
    description: "Net movement and line count per account, this fiscal year.",
    query: {
      entity: "ledger_lines",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "account_number" },
        { column: "account_name" },
        { column: "account_type" },
      ],
      measures: [
        { fn: "sum", column: "amount", label: "Net change (base)" },
        { fn: "count", label: "Lines" },
      ],
      filters: {
        combinator: "and",
        rules: [
          { field: "entry_status", op: "eq", value: "posted" },
          { field: "posting_date", op: "period_preset", value: "this_fiscal_year" },
        ],
      },
      groupBy: null,
      limit: 5000,
    },
  },
  {
    slug: "expense-detail-by-department-fy",
    name: "Expense detail by department",
    description: "Expense and COGS lines this fiscal year, by department.",
    query: {
      entity: "ledger_lines",
      mode: "rows",
      columns: [
        "posting_date",
        "entry_number",
        "account_number",
        "account_name",
        "party_name",
        "project",
        "memo",
        "amount",
      ],
      breakouts: [],
      measures: [],
      filters: {
        combinator: "and",
        rules: [
          { field: "entry_status", op: "eq", value: "posted" },
          { field: "posting_date", op: "period_preset", value: "this_fiscal_year" },
          {
            field: "account_type",
            op: "in",
            value: ["expense", "expense_other", "expense_deferred", "cogs"],
          },
        ],
      },
      groupBy: "department",
      sorts: [{ column: "posting_date", direction: "asc" }],
      limit: 10000,
    },
  },
  {
    slug: "lot-recall",
    name: "Lot recall",
    description: "Every movement for a lot — item, location, quantity, expiry.",
    urlFilters: [
      { param: "lotNumber", field: "lot_number", op: "contains", valueKind: "text" },
      { param: "itemId", field: "item_id", op: "eq", valueKind: "uuid" },
      { param: "expiresOnOrBefore", field: "expires_on", op: "lte", valueKind: "date" },
      {
        param: "expiring",
        field: "expires_on",
        op: "is_not_null",
        valueKind: "flag",
        activeValue: "1",
      },
    ],
    query: {
      entity: "inventory_lot_movements",
      mode: "rows",
      columns: [
        "lot_number",
        "expires_on",
        "item_code",
        "item_name",
        "kind",
        "moved_at",
        "quantity",
        "location_code",
        "document_number",
        "party_name",
      ],
      breakouts: [],
      measures: [],
      filters: null,
      groupBy: null,
      // The second level is the immutable unique tie-breaker that keeps page
      // boundaries deterministic when several movements share a timestamp.
      sorts: [
        { column: "moved_at", direction: "desc" },
        { column: "movement_id", direction: "desc" },
      ],
      limit: 100,
    },
  },
  {
    slug: "backorders",
    name: "Backorders",
    description: "Stock lines still owed on sales orders: ordered, fulfilled, cancelled and open.",
    urlFilters: [
      { param: "itemId", field: "item_id", op: "eq", valueKind: "uuid" },
      { param: "orderId", field: "document_id", op: "eq", valueKind: "uuid" },
    ],
    query: {
      entity: "backorders",
      mode: "rows",
      columns: [
        "document_number",
        "document_date",
        "party_name",
        "item_code",
        "item_name",
        "location_code",
        "quantity",
        "quantity_fulfilled",
        "quantity_cancelled",
        "open_quantity",
      ],
      breakouts: [],
      measures: [],
      filters: null,
      groupBy: null,
      // The line id is the unique tie-breaker that keeps the order stable.
      sorts: [
        { column: "document_date", direction: "asc" },
        { column: "document_number", direction: "asc" },
        { column: "line_id", direction: "asc" },
      ],
      limit: 10000,
    },
  },
  {
    slug: "payroll-register",
    name: "Payroll register",
    description: "Pay stubs this fiscal year — gross, withholdings, net, employer cost.",
    query: {
      entity: "pay_stubs",
      mode: "rows",
      columns: [
        "employee",
        "province",
        "gross",
        "cpp_fica",
        "ei",
        "income_tax",
        "net_pay",
        "employer_cost",
        "pay_date",
      ],
      groupBy: "run_number",
      filters: {
        combinator: "and",
        rules: [{ field: "pay_date", op: "period_preset", value: "this_fiscal_year" }],
      },
      sorts: [{ column: "pay_date", direction: "desc" }],
      limit: 5000,
    },
  },
  {
    slug: "payroll-journal",
    name: "Payroll journal",
    description: "Per-employee audit detail — earnings, deductions, amounts and YTD.",
    query: {
      entity: "pay_stub_lines",
      mode: "summarize",
      columns: [],
      // One line per component per employee — period totals plus the exact
      // end-of-window YTD (the 'latest' running figure, not a max).
      breakouts: [{ column: "employee" }, { column: "line_kind" }, { column: "component" }],
      measures: [
        { fn: "sum", column: "hours", label: "Hours" },
        { fn: "sum", column: "amount", label: "Amount" },
        { fn: "latest", column: "ytd_amount", label: "YTD amount" },
      ],
      groupBy: "employee",
      totals: {
        sections: true,
        grand: true,
        // The Paymate-style footer line: what actually hits the bank account.
        derived: [
          {
            label: "Net pay",
            plus: { field: "line_kind", value: "earning" },
            minus: { field: "line_kind", value: "deduction" },
          },
        ],
      },
      filters: {
        combinator: "and",
        rules: [{ field: "pay_date", op: "period_preset", value: "this_fiscal_year" }],
      },
      limit: 10000,
    },
  },
  {
    slug: "payroll-deductions-register",
    name: "Deductions & contributions register",
    description: "Withholdings and employer contributions by component, with YTD.",
    query: {
      entity: "pay_stub_lines",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "component" }, { column: "employee" }, { column: "line_kind" }],
      measures: [
        { fn: "sum", column: "amount", label: "Amount" },
        { fn: "latest", column: "ytd_amount", label: "YTD amount" },
      ],
      groupBy: "component",
      filters: {
        combinator: "and",
        rules: [
          { field: "pay_date", op: "period_preset", value: "this_fiscal_year" },
          { field: "line_kind", op: "in", value: ["deduction", "employer_contribution"] },
        ],
      },
      limit: 10000,
    },
  },
  {
    slug: "payroll-cost-by-department",
    name: "Payroll cost by department",
    description: "Payroll amounts by department and component kind.",
    query: {
      entity: "pay_stub_lines",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "department" }, { column: "line_kind" }],
      measures: [
        { fn: "sum", column: "amount", label: "Amount" },
        { fn: "count", label: "Lines" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "pay_date", op: "period_preset", value: "this_fiscal_year" }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "payroll-employee-totals",
    name: "Employee totals (YTD)",
    description: "Gross, tax, net and employer cost per employee, with stub counts.",
    query: {
      entity: "pay_stubs",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "employee" }],
      measures: [
        { fn: "sum", column: "gross", label: "Gross pay" },
        { fn: "sum", column: "income_tax", label: "Income tax withheld" },
        { fn: "sum", column: "net_pay", label: "Net pay" },
        { fn: "sum", column: "employer_cost", label: "Employer cost" },
        { fn: "count", label: "Stubs" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "pay_date", op: "period_preset", value: "this_fiscal_year" }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "payroll-cost-by-month",
    name: "Payroll cost by month",
    description: "Monthly payroll totals — gross, net, tax and employer cost.",
    query: {
      entity: "pay_stubs",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "pay_date", bin: "month" }, { column: "schedule" }],
      measures: [
        { fn: "sum", column: "gross", label: "Gross pay" },
        { fn: "sum", column: "income_tax", label: "Income tax withheld" },
        { fn: "sum", column: "net_pay", label: "Net pay" },
        { fn: "sum", column: "employer_cost", label: "Employer cost" },
        { fn: "count", label: "Stubs" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "pay_date", op: "period_preset", value: "this_fiscal_year" }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "payroll-parallel-run",
    name: "Parallel run reconciliation",
    description: "One period checked against the prior provider, sectioned by result.",
    query: {
      entity: "payroll_parallel_findings",
      mode: "rows",
      columns: [
        "employee",
        "line_kind",
        "component",
        "prior_amount",
        "our_amount",
        "difference",
        "tolerance_applied",
        "source_column",
        "run_number",
        "register",
      ],
      // Sectioned by RESULT, not by employee: an operator running a parallel
      // run wants the differences, and a report that opens on three hundred
      // matching rows is a report nobody reads to the bottom.
      groupBy: "classification",
      filters: {
        combinator: "and",
        rules: [{ field: "pay_date", op: "period_preset", value: "this_fiscal_year" }],
      },
      sorts: [
        { column: "employee", direction: "asc" },
        { column: "component", direction: "asc" },
      ],
      limit: 10000,
    },
  },
  {
    slug: "payroll-parallel-run-totals",
    name: "Parallel run totals by component",
    description: "Prior-provider vs calculated totals per component, with differences.",
    query: {
      entity: "payroll_parallel_findings",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "line_kind" }, { column: "component" }],
      measures: [
        { fn: "sum", column: "prior_amount", label: "Prior system" },
        { fn: "sum", column: "our_amount", label: "This system" },
        { fn: "sum", column: "difference", label: "Difference" },
        { fn: "max", column: "tolerance_applied", label: "Tolerance allowed" },
        { fn: "latest", column: "employees_compared", label: "Employees compared" },
        { fn: "count", label: "Cells" },
      ],
      groupBy: "line_kind",
      totals: { sections: true, grand: true },
      filters: {
        combinator: "and",
        rules: [{ field: "pay_date", op: "period_preset", value: "this_fiscal_year" }],
      },
      sorts: [{ column: "component", direction: "asc" }],
      limit: 10000,
    },
  },
  {
    slug: "entitlement-balances",
    name: "Entitlement balances",
    description: "Time-off and benefit balances per employee, with plan limits.",
    query: {
      entity: "entitlement_balances",
      mode: "rows",
      columns: [
        "employee",
        "job_title",
        "balance",
        "max_balance",
        "headroom",
        "limit_state",
        "limit_scope",
        "last_movement_date",
      ],
      breakouts: [],
      measures: [],
      groupBy: "plan",
      sorts: [{ column: "balance", direction: "desc" }],
      limit: 5000,
    },
  },
  {
    slug: "allocation-summary",
    name: "Allocation summary",
    description: "Pooled source, allocated total and residual, per rule and period.",
    query: {
      entity: "allocation_runs",
      mode: "summarize",
      columns: [],
      breakouts: [{ column: "rule_name" }, { column: "period" }, { column: "status" }],
      measures: [
        { fn: "sum", column: "source_total", label: "Source total" },
        { fn: "sum", column: "allocated_total", label: "Allocated" },
        { fn: "sum", column: "residual", label: "Residual" },
        { fn: "count", label: "Runs" },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "allocation-lineage",
    name: "Allocation lineage",
    description: "Allocated lines traced to rule, source, account and share.",
    query: {
      entity: "allocation_lineage",
      mode: "rows",
      columns: [
        "rule_name",
        "mode",
        "period",
        "account_number",
        "account_name",
        "department",
        "share",
        "amount",
        "residual",
        "created_at",
      ],
      breakouts: [],
      measures: [],
      filters: null,
      groupBy: "rule_name",
      sorts: [{ column: "created_at", direction: "desc" }],
      limit: 5000,
    },
  },
  {
    slug: "entitlement-service-milestones",
    name: "Service milestones reached",
    description: "Service anniversaries this fiscal year that change entitlements.",
    query: {
      entity: "entitlement_service_milestones",
      mode: "rows",
      columns: [
        "employee",
        "milestone_date",
        "milestone",
        "milestone_kind",
        "after_years",
        "accrual_value",
        "hired_on",
        "department",
      ],
      breakouts: [],
      measures: [],
      groupBy: "milestone_kind",
      filters: {
        combinator: "and",
        rules: [{ field: "milestone_date", op: "period_preset", value: "this_fiscal_year" }],
      },
      sorts: [{ column: "milestone_date", direction: "asc" }],
      limit: 5000,
    },
  },
  {
    slug: "crm-pipeline-summary",
    name: "Pipeline summary by stage",
    description: "Open pipeline amounts, counts and weighted values by stage.",
    query: {
      entity: "crm_opportunities",
      mode: "summarize",
      breakouts: [
        { column: "status_name" },
        { column: "forecast_category" },
        { column: "currency" },
      ],
      columns: [],
      measures: [
        { column: "projected_amount", fn: "sum", label: "Projected amount" },
        { column: "weighted_amount", fn: "sum", label: "Weighted amount" },
        { fn: "count", label: "Opportunities" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "is_closed", op: "is_false" }],
      },
      sorts: [{ column: "status_name", direction: "asc" }],
    },
  },
  {
    slug: "crm-forecast-by-owner",
    name: "Pipeline forecast by owner",
    description: "Projected and weighted pipeline by owner and category.",
    query: {
      entity: "crm_opportunities",
      mode: "summarize",
      breakouts: [
        { column: "owner_name" },
        { column: "forecast_category" },
        { column: "currency" },
      ],
      columns: [],
      measures: [
        { column: "projected_amount", fn: "sum", label: "Projected amount" },
        { column: "weighted_amount", fn: "sum", label: "Weighted amount" },
        { fn: "count", label: "Opportunities" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "is_closed", op: "is_false" }],
      },
      sorts: [{ column: "owner_name", direction: "asc" }],
    },
  },
  {
    slug: "crm-win-loss-analysis",
    name: "Win/loss analysis",
    description: "Closed deals by outcome and reason, with totals.",
    query: {
      entity: "crm_opportunities",
      mode: "summarize",
      breakouts: [{ column: "is_won" }, { column: "win_loss_reason" }, { column: "currency" }],
      columns: [],
      measures: [
        { column: "projected_amount", fn: "sum", label: "Closed amount" },
        { fn: "count", label: "Deals" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "is_closed", op: "is_true" }],
      },
      sorts: [{ column: "is_won", direction: "desc" }],
    },
  },
  {
    slug: "crm-lead-conversion-funnel",
    name: "Lead lifecycle & source summary",
    description: "Accounts by lifecycle stage, status and lead source.",
    query: {
      entity: "crm_account_profiles",
      mode: "summarize",
      breakouts: [
        { column: "lifecycle_stage" },
        { column: "status_name" },
        { column: "lead_source_name" },
      ],
      columns: [],
      measures: [{ fn: "count", label: "Accounts" }],
      filters: null,
      sorts: [{ column: "lifecycle_stage", direction: "asc" }],
    },
  },
  {
    slug: "usage-billing-detail",
    name: "Usage billing detail",
    description: "Rated usage invoice lines with meter, rating run, plan version and source trace.",
    query: {
      entity: "usage_billing_lines",
      mode: "rows",
      columns: [
        "document_number",
        "document_date",
        "status",
        "party_name",
        "line_number",
        "currency",
        "amount",
        "run_id",
        "plan_version_id",
        "meter_id",
        "meter_key",
        "kind",
        "band_seq",
        "quantity",
        "unit_price",
        "records_hash",
        "period_start",
        "period_end",
        "commit_window_start",
        "commit_window_end",
        "rated_total",
      ],
      breakouts: [],
      measures: [],
      filters: null,
      groupBy: null,
      sorts: [
        { column: "document_date", direction: "desc" },
        { column: "line_number", direction: "asc" },
      ],
      limit: 1000,
    },
  },
  ...SAAS_METRICS_BUILT_IN_REPORTS,
  ...WORKFORCE_BUILT_IN_REPORT_DEFINITIONS,
  ...BENEFITS_REPORT_ENTITIES.map((entity) => ({
    slug: `workforce-${entity.key.replace(/^hrm_/, "").replaceAll("_", "-")}`,
    name: entity.label,
    description: entity.description,
    query: { ...defaultRowsQuery(entity), columns: entity.columns.map((column) => column.key) },
  })),
  ...SHIPPING_REPORT_ENTITIES.map((entity) => ({
    slug: entity.key.replaceAll("_", "-"),
    name: entity.label,
    description: entity.description,
    query: { ...defaultRowsQuery(entity), columns: entity.columns.map((column) => column.key) },
  })),
  {
    slug: "shipping-cost-by-carrier",
    name: "Shipping cost by carrier",
    description: "Bought label cost by carrier and service per purchase month, with label counts.",
    query: {
      entity: "shipment_labels",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "carrier" },
        { column: "service" },
        { column: "purchased_date", bin: "month" },
      ],
      measures: [
        { fn: "sum", column: "amount", label: "Label cost" },
        { fn: "count", label: "Labels" },
      ],
      filters: {
        combinator: "and",
        rules: [{ field: "status", op: "eq", value: "purchased" }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: "headcount-statement",
    name: "Headcount statement",
    description: "Headcount and FTE by subsidiary and department, with totals.",
    query: {
      entity: "hrm_headcount",
      mode: "summarize",
      columns: [],
      // One row per subsidiary × department group. The organization total
      // rides the shared summary band (Total headcount / Total FTE), which
      // the ExportData conversion repeats as footer rows — so the statement
      // PDF, CSV and XLSX all carry it with no bespoke total row.
      breakouts: [{ column: "subsidiary" }, { column: "department" }],
      measures: [
        { fn: "sum", column: "headcount", label: "Headcount" },
        { fn: "sum", column: "fte_total", label: "Full-time equivalents" },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
];

/** O(1) catalog lookup shared by native routes, exports, and saved views. */
export const BUILT_IN_REPORT_DEFINITION_MAP: Readonly<Record<string, BuiltInReportDefinition>> =
  Object.fromEntries(
    BUILT_IN_REPORT_DEFINITIONS.map((definition) => [definition.slug, definition]),
  );

const VALUE_OPS: Record<BuiltInReportUrlFilter["valueKind"], readonly ReportFilterOperator[]> = {
  text: ["eq", "neq", "contains"],
  uuid: ["eq", "neq"],
  date: ["eq", "neq", "gte", "lte"],
  flag: ["is_null", "is_not_null", "is_true", "is_false"],
};

function readUrlValue(values: BuiltInReportUrlValues, param: string): string | null {
  if ("get" in values && typeof values.get === "function") return values.get(param);
  const raw = (values as Readonly<Record<string, string | readonly string[] | null | undefined>>)[
    param
  ];
  if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : null;
  return typeof raw === "string" ? raw : null;
}

/** Apply a built-in's catalog-authored URL controls to its query. Screen,
 *  export, and saved-view paths call this same pure helper, so none can drift
 *  onto a different effective filter set. Invalid active values fail closed;
 *  absent/empty controls simply add no rule. */
export function applyBuiltInUrlFilters(
  definition: BuiltInReportDefinition,
  values: BuiltInReportUrlValues,
): ReportCustomQuery {
  const bindings = definition.urlFilters ?? [];
  if (bindings.length > 12) throw new Error(`built-in ${definition.slug} has too many URL filters`);
  const entity = REPORT_ENTITY_MAP[definition.query.entity];
  if (!entity) throw new Error(`built-in ${definition.slug} has an unknown entity`);

  const rules: ReportRule[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(binding.param) || seen.has(binding.param)) {
      throw new Error(`built-in ${definition.slug} has an invalid URL parameter binding`);
    }
    seen.add(binding.param);
    const column = entityColumn(entity, binding.field);
    if (!column || !VALUE_OPS[binding.valueKind].includes(binding.op)) {
      throw new Error(`built-in ${definition.slug} has an invalid URL filter binding`);
    }
    if (binding.valueKind === "uuid" && column.kind !== "uuid") {
      throw new Error(`built-in ${definition.slug} binds a UUID to a non-UUID field`);
    }
    if (binding.valueKind === "date" && column.kind !== "date" && column.kind !== "timestamp") {
      throw new Error(`built-in ${definition.slug} binds a date to a non-date field`);
    }
    if (binding.valueKind === "flag" && !binding.activeValue) {
      throw new Error(`built-in ${definition.slug} has a flag without an activation value`);
    }

    const raw = readUrlValue(values, binding.param);
    if (raw === null || raw.trim() === "") continue;
    const value = raw.trim();
    if (value.length > 500) throw new Error(`Invalid report parameter: ${binding.param}`);
    if (binding.valueKind === "flag") {
      if (value === binding.activeValue) rules.push({ field: binding.field, op: binding.op });
      continue;
    }
    if (
      binding.valueKind === "uuid" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ) {
      throw new Error(`Invalid report parameter: ${binding.param}`);
    }
    if (binding.valueKind === "date" && !isCalendarDate(value)) {
      throw new Error(`Invalid report parameter: ${binding.param}`);
    }
    rules.push({ field: binding.field, op: binding.op, value });
  }

  if (rules.length === 0) return definition.query;
  return {
    ...definition.query,
    filters: {
      combinator: "and",
      rules: [...(definition.query.filters ? [definition.query.filters] : []), ...rules],
    },
  };
}
