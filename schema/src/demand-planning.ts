import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Statistical demand planning for stocked items. Weekly forecasts per item
 * and stock location feed reviewable purchase and transfer suggestions;
 * operator overrides with reasons win over the model for their period.
 */

export const demandItemPolicies = pgTable(
  "demand_item_policies",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    leadTimeDays: integer("lead_time_days"),
    reviewCycleDays: integer("review_cycle_days"),
    serviceLevel: numeric("service_level", { precision: 5, scale: 4 }),
    moqQty: money("moq_qty"),
    casePackQty: money("case_pack_qty"),
    preferredSupplierId: uuid("preferred_supplier_id"),
    forecastMethod: text("forecast_method", {
      enum: ["auto", "seasonal", "intermittent", "average"],
    }),
    historyWeeks: integer("history_weeks"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("demand_item_policies_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("demand_item_policies_org_item_unique").on(t.orgId, t.itemId),
    check(
      "demand_item_policies_lead_time_nonnegative",
      sql`${t.leadTimeDays} is null or ${t.leadTimeDays} >= 0`,
    ),
    check(
      "demand_item_policies_review_cycle_nonnegative",
      sql`${t.reviewCycleDays} is null or ${t.reviewCycleDays} >= 0`,
    ),
    check(
      "demand_item_policies_service_level_range",
      sql`${t.serviceLevel} is null or (${t.serviceLevel} >= 0.5 and ${t.serviceLevel} <= 0.9999)`,
    ),
    check(
      "demand_item_policies_quantities_nonnegative",
      sql`(${t.moqQty} is null or ${t.moqQty} >= 0) and (${t.casePackQty} is null or ${t.casePackQty} > 0)`,
    ),
    check(
      "demand_item_policies_history_weeks_range",
      sql`${t.historyWeeks} is null or (${t.historyWeeks} >= 4 and ${t.historyWeeks} <= 156)`,
    ),
  ],
);

export const demandForecastRuns = pgTable(
  "demand_forecast_runs",
  {
    id: id(),
    orgId: orgRef(),
    number: text("number").notNull(),
    asOf: date("as_of").notNull(),
    horizonWeeks: integer("horizon_weeks").notNull(),
    status: text("status", { enum: ["draft", "complete", "superseded"] })
      .notNull()
      .default("draft"),
    parameters: jsonb("parameters").notNull(),
    runBy: uuid("run_by").notNull(),
    ranAt: timestamp("ran_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("demand_forecast_runs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("demand_forecast_runs_org_number_unique").on(t.orgId, t.number),
    index("demand_forecast_runs_org_status_as_of").on(t.orgId, t.status, t.asOf),
    check(
      "demand_forecast_runs_horizon_valid",
      sql`${t.horizonWeeks} >= 1 and ${t.horizonWeeks} <= 52`,
    ),
  ],
);

export const demandForecasts = pgTable(
  "demand_forecasts",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodGrain: text("period_grain", { enum: ["week", "month"] }).notNull(),
    forecastQty: money("forecast_qty").notNull(),
    lowerQty: money("lower_qty").notNull(),
    upperQty: money("upper_qty").notNull(),
    method: text("method", {
      enum: [
        "seasonal_additive",
        "seasonal_multiplicative",
        "croston_sba",
        "moving_average",
        "override",
      ],
    }).notNull(),
    explanation: jsonb("explanation").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("demand_forecasts_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("demand_forecasts_org_run_item_location_period_unique").on(
      t.orgId,
      t.runId,
      t.itemId,
      t.stockLocationId,
      t.periodStart,
    ),
    index("demand_forecasts_org_item_location_period").on(
      t.orgId,
      t.itemId,
      t.stockLocationId,
      t.periodStart,
    ),
    check(
      "demand_forecasts_quantities_nonnegative",
      sql`${t.forecastQty} >= 0 and ${t.lowerQty} >= 0 and ${t.upperQty} >= 0`,
    ),
    check(
      "demand_forecasts_band_valid",
      sql`${t.lowerQty} <= ${t.forecastQty} and ${t.forecastQty} <= ${t.upperQty}`,
    ),
  ],
);

export const demandPlanSuggestions = pgTable(
  "demand_plan_suggestions",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    action: text("action", { enum: ["buy", "transfer"] }).notNull(),
    quantity: money("quantity").notNull(),
    dueDate: date("due_date").notNull(),
    plannedStart: date("planned_start"),
    forecastQty: money("forecast_qty").notNull(),
    projectedSupply: money("projected_supply").notNull(),
    daysOfCover: money("days_of_cover"),
    status: text("status", {
      enum: ["suggested", "confirmed", "converted", "dismissed"],
    })
      .notNull()
      .default("suggested"),
    convertedRefId: uuid("converted_ref_id"),
    dismissReason: text("dismiss_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("demand_plan_suggestions_org_id_id_unique").on(t.orgId, t.id),
    index("demand_plan_suggestions_org_run_status").on(t.orgId, t.runId, t.status),
    check(
      "demand_plan_suggestions_quantity_positive",
      sql`${t.quantity} > 0`,
    ),
    check(
      "demand_plan_suggestions_forecast_nonnegative",
      sql`${t.forecastQty} >= 0`,
    ),
    check(
      "demand_plan_suggestions_cover_nonnegative",
      sql`${t.daysOfCover} is null or ${t.daysOfCover} >= 0`,
    ),
    check(
      "demand_plan_suggestions_dismiss_reason",
      sql`(${t.status} <> 'dismissed' and ${t.dismissReason} is null)
        or (${t.status} = 'dismissed' and ${t.dismissReason} is not null
          and length(btrim(${t.dismissReason})) between 5 and 500)`,
    ),
  ],
);

export const demandForecastOverrides = pgTable(
  "demand_forecast_overrides",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    periodStart: date("period_start").notNull(),
    quantity: money("quantity").notNull(),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("demand_forecast_overrides_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("demand_forecast_overrides_org_item_location_period_unique").on(
      t.orgId,
      t.itemId,
      t.stockLocationId,
      t.periodStart,
    ),
    check(
      "demand_forecast_overrides_quantity_nonnegative",
      sql`${t.quantity} >= 0`,
    ),
    check(
      "demand_forecast_overrides_reason_valid",
      sql`length(btrim(${t.reason})) between 5 and 500`,
    ),
  ],
);

/** Re-export guard: every table above is registered in schema/src/index.ts. */
export const demandPlanningTables = [
  demandItemPolicies,
  demandForecastRuns,
  demandForecasts,
  demandPlanSuggestions,
  demandForecastOverrides,
] as const;
