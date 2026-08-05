import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

export const CRM_FORECAST_CATEGORIES = ["omitted", "worst_case", "most_likely", "upside"] as const;

export const crmOpportunityStatuses = pgTable(
  "crm_opportunity_statuses",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sequence: integer("sequence").notNull().default(0),
    probability: integer("probability").notNull().default(0),
    defaultForecastCategory: text("default_forecast_category", { enum: CRM_FORECAST_CATEGORIES }).notNull().default("upside"),
    isClosed: boolean("is_closed").notNull().default(false),
    isWon: boolean("is_won").notNull().default(false),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_opportunity_statuses_org_key").on(t.orgId, t.key),
    index("crm_opportunity_statuses_org_sequence").on(t.orgId, t.sequence),
    check("crm_opportunity_status_probability", sql`${t.probability} >= 0 and ${t.probability} <= 100`),
    check("crm_opportunity_status_won_closed", sql`not ${t.isWon} or ${t.isClosed}`),
  ],
);

export const crmSalesTeams = pgTable(
  "crm_sales_teams",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    managerUserId: uuid("manager_user_id"),
    parentTeamId: uuid("parent_team_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("crm_sales_teams_org_key").on(t.orgId, t.key)],
);

export const crmSalesTeamMembers = pgTable(
  "crm_sales_team_members",
  {
    id: id(),
    orgId: orgRef(),
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").notNull().default("member"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("crm_sales_team_members_unique").on(t.teamId, t.userId)],
);

export const crmOpportunities = pgTable(
  "crm_opportunities",
  {
    id: id(),
    orgId: orgRef(),
    opportunityNumber: text("opportunity_number").notNull(),
    title: text("title").notNull(),
    partyId: uuid("party_id"),
    primaryContactId: uuid("primary_contact_id"),
    ownerUserId: uuid("owner_user_id"),
    salesTeamId: uuid("sales_team_id"),
    statusId: uuid("status_id").notNull(),
    leadSourceId: uuid("lead_source_id"),
    expectedCloseDate: date("expected_close_date"),
    forecastCategory: text("forecast_category", { enum: CRM_FORECAST_CATEGORIES }).notNull().default("upside"),
    probability: integer("probability").notNull().default(0),
    currency: currencyCode("currency").notNull(),
    projectedAmount: money("projected_amount").notNull().default("0"),
    weightedAmount: money("weighted_amount").notNull().default("0"),
    rangeLow: money("range_low"),
    rangeHigh: money("range_high"),
    subsidiaryId: uuid("subsidiary_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    extraDims: jsonb("extra_dims").notNull().default({}),
    nextStep: text("next_step"),
    competitorNotes: text("competitor_notes"),
    winLossReason: text("win_loss_reason"),
    description: text("description"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_opportunities_org_number").on(t.orgId, t.opportunityNumber),
    index("crm_opportunities_pipeline").on(t.orgId, t.statusId, t.expectedCloseDate),
    index("crm_opportunities_owner").on(t.orgId, t.ownerUserId, t.expectedCloseDate),
    index("crm_opportunities_party").on(t.orgId, t.partyId),
    check("crm_opportunity_probability", sql`${t.probability} >= 0 and ${t.probability} <= 100`),
    check("crm_opportunity_amounts", sql`${t.projectedAmount} >= 0 and ${t.weightedAmount} >= 0 and (${t.rangeLow} is null or ${t.rangeLow} >= 0) and (${t.rangeHigh} is null or ${t.rangeHigh} >= 0) and (${t.rangeLow} is null or ${t.rangeHigh} is null or ${t.rangeHigh} >= ${t.rangeLow})`),
  ],
);

export const crmOpportunityLines = pgTable(
  "crm_opportunity_lines",
  {
    id: id(),
    orgId: orgRef(),
    opportunityId: uuid("opportunity_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id"),
    description: text("description"),
    quantity: money("quantity").notNull().default("1"),
    unit: text("unit"),
    unitPrice: money("unit_price").notNull().default("0"),
    amount: money("amount").notNull().default("0"),
    probability: integer("probability"),
    expectedAmount: money("expected_amount").notNull().default("0"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_opportunity_lines_number").on(t.opportunityId, t.lineNumber),
    index("crm_opportunity_lines_opportunity").on(t.opportunityId),
    check("crm_opportunity_line_values", sql`${t.quantity} > 0 and ${t.unitPrice} >= 0 and ${t.amount} >= 0 and ${t.expectedAmount} >= 0 and (${t.probability} is null or (${t.probability} >= 0 and ${t.probability} <= 100))`),
  ],
);

/** Snapshot sales-team contribution on a deal; must total 100% when present. */
export const crmOpportunityTeamMembers = pgTable(
  "crm_opportunity_team_members",
  {
    id: id(),
    orgId: orgRef(),
    opportunityId: uuid("opportunity_id").notNull(),
    userId: uuid("user_id").notNull(),
    contributionPercent: money("contribution_percent").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_opportunity_team_members_unique").on(t.opportunityId, t.userId),
    check("crm_opportunity_contribution", sql`${t.contributionPercent} > 0 and ${t.contributionPercent} <= 100`),
  ],
);

/** Links estimates/orders/invoices to their originating opportunity. */
export const crmOpportunityDocuments = pgTable(
  "crm_opportunity_documents",
  {
    id: id(),
    orgId: orgRef(),
    opportunityId: uuid("opportunity_id").notNull(),
    documentId: uuid("document_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_opportunity_documents_document").on(t.documentId),
    index("crm_opportunity_documents_opportunity").on(t.opportunityId),
  ],
);

export const crmOpportunityStageEvents = pgTable(
  "crm_opportunity_stage_events",
  {
    id: id(),
    orgId: orgRef(),
    opportunityId: uuid("opportunity_id").notNull(),
    fromStatusId: uuid("from_status_id"),
    toStatusId: uuid("to_status_id").notNull(),
    probability: integer("probability").notNull(),
    forecastCategory: text("forecast_category", { enum: CRM_FORECAST_CATEGORIES }).notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [index("crm_opportunity_stage_events_opportunity").on(t.opportunityId, t.occurredAt)],
);

/** Period quota for a rep or team, optionally narrowed by dimensions. */
export const crmSalesQuotas = pgTable(
  "crm_sales_quotas",
  {
    id: id(),
    orgId: orgRef(),
    ownerUserId: uuid("owner_user_id"),
    salesTeamId: uuid("sales_team_id"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    currency: currencyCode("currency").notNull(),
    amount: money("amount").notNull(),
    filters: jsonb("filters").$type<Record<string, string>>().notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("crm_sales_quotas_owner_period").on(t.orgId, t.ownerUserId, t.periodStart, t.periodEnd),
    check("crm_sales_quota_target", sql`num_nonnulls(${t.ownerUserId}, ${t.salesTeamId}) = 1`),
    check("crm_sales_quota_dates", sql`${t.periodEnd} >= ${t.periodStart}`),
    check("crm_sales_quota_amount", sql`${t.amount} >= 0`),
  ],
);

/** Append-only rep/manager forecast snapshots and overrides. */
export const crmForecastSnapshots = pgTable(
  "crm_forecast_snapshots",
  {
    id: id(),
    orgId: orgRef(),
    ownerUserId: uuid("owner_user_id"),
    salesTeamId: uuid("sales_team_id"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull().defaultNow(),
    snapshotKind: text("snapshot_kind", { enum: ["calculated", "rep_override", "manager_override"] }).notNull(),
    currency: currencyCode("currency").notNull(),
    pipelineAmount: money("pipeline_amount").notNull(),
    weightedAmount: money("weighted_amount").notNull(),
    worstCaseAmount: money("worst_case_amount").notNull(),
    mostLikelyAmount: money("most_likely_amount").notNull(),
    upsideAmount: money("upside_amount").notNull(),
    closedAmount: money("closed_amount").notNull(),
    overrideAmount: money("override_amount"),
    note: text("note"),
    detail: jsonb("detail").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("crm_forecast_snapshots_owner_period").on(t.orgId, t.ownerUserId, t.periodStart, t.periodEnd, t.asOf),
    check("crm_forecast_snapshot_target", sql`num_nonnulls(${t.ownerUserId}, ${t.salesTeamId}) = 1`),
    check("crm_forecast_snapshot_dates", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

/*
FOREIGN KEYS live in schema/migrations/referential-integrity.sql.
*/
