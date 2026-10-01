import { sql } from "drizzle-orm";
import {
  bigint,
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
    salesRepId: uuid("sales_rep_id"),
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
    /** Strictly increasing OCC counter, see documents.revisionSeq (migration 0167). */
    revisionSeq: bigint("revision_seq", { mode: "number" }).notNull().default(0),
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

export const crmSalesTeams = pgTable('crm_sales_teams', { id:id(), orgId:orgRef(), key:text('key').notNull(), name:text('name').notNull(), managerEmployeeId:uuid('manager_employee_id'), subsidiaryId:uuid('subsidiary_id'), isActive:boolean('is_active').notNull().default(true), revision:integer('revision').notNull().default(1), ...auditColumns })
export const crmSalesTeamMembers = pgTable('crm_sales_team_members', { id:id(), orgId:orgRef(), teamId:uuid('team_id').notNull(), employeeId:uuid('employee_id').notNull(), role:text('role').notNull().default('member'), validFrom:date('valid_from').notNull(), validTo:date('valid_to'), isActive:boolean('is_active').notNull().default(true), ...auditColumns })
export const crmSalesTerritories = pgTable('crm_sales_territories', { id:id(), orgId:orgRef(), key:text('key').notNull(), name:text('name').notNull(), description:text('description'), managerEmployeeId:uuid('manager_employee_id'), defaultEmployeeId:uuid('default_employee_id'), salesTeamId:uuid('sales_team_id'), subsidiaryId:uuid('subsidiary_id'), priority:integer('priority').notNull().default(100), rules:jsonb('rules').notNull().default([]), matchMode:text('match_mode').notNull().default('all'), geography:jsonb('geography').notNull().default({version:1,includes:[],excludes:[],polygons:[]}), effectiveFrom:date('effective_from').notNull(), lifecycle:text('lifecycle').notNull().default('draft'), isActive:boolean('is_active').notNull().default(true), revision:integer('revision').notNull().default(1), ...auditColumns })
export const crmSalesQuotas = pgTable('crm_sales_quotas', { id:id(), orgId:orgRef(), employeeId:uuid('employee_id'), salesTeamId:uuid('sales_team_id'), subsidiaryId:uuid('subsidiary_id'), parentQuotaId:uuid('parent_quota_id'), supersedesId:uuid('supersedes_id'), name:text('name'), periodStart:date('period_start').notNull(), periodEnd:date('period_end').notNull(), currency:currencyCode('currency').notNull(), amount:money('amount').notNull(), metric:text('metric').notNull().default('closed_won'), lifecycle:text('lifecycle').notNull().default('draft'), approvedBy:uuid('approved_by'), approvedAt:timestamp('approved_at',{withTimezone:true}), reason:text('reason'), revision:integer('revision').notNull().default(1), ...auditColumns })
export const crmSalesTerritoryVersions = pgTable('crm_sales_territory_versions', {id:id(),orgId:orgRef(),territoryId:uuid('territory_id').notNull(),revision:integer('revision').notNull(),effectiveFrom:date('effective_from').notNull(),definition:jsonb('definition').notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),createdBy:uuid('created_by')})
export const crmSalesEvidence = pgTable('crm_sales_evidence', {id:id(),orgId:orgRef(),sourceKind:text('source_kind').notNull(),sourceId:uuid('source_id').notNull(),sourceNumber:text('source_number').notNull(),sourceRevision:bigint('source_revision',{mode:'number'}).notNull(),eventKind:text('event_kind').notNull(),metric:text('metric').notNull(),employeeId:uuid('employee_id'),salesTeamId:uuid('sales_team_id'),subsidiaryId:uuid('subsidiary_id'),currency:currencyCode('currency').notNull(),amount:money('amount').notNull(),effectiveDate:date('effective_date'),reversesId:uuid('reverses_id'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),createdBy:uuid('created_by')})
