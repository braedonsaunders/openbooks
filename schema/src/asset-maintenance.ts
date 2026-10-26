import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/** Meter readings (hours, kilometres, cycles) per asset (migration 0689). */
export const assetUsageReadings = pgTable(
  "asset_usage_readings",
  {
    id: id(),
    orgId: orgRef(),
    assetId: uuid("asset_id").notNull(),
    readOn: date("read_on").notNull(),
    reading: money("reading").notNull(),
    unit: text("unit").notNull(),
    memo: text("memo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("asset_usage_readings_org_id_id_unique").on(t.orgId, t.id),
    index("asset_usage_readings_asset").on(t.orgId, t.assetId, t.unit, t.readOn),
    check("asset_usage_readings_reading", sql`${t.reading} >= 0`),
  ],
);

/** Time and/or usage maintenance intervals with the computed next due point. */
export const assetMaintenanceSchedules = pgTable(
  "asset_maintenance_schedules",
  {
    id: id(),
    orgId: orgRef(),
    assetId: uuid("asset_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    intervalMonths: integer("interval_months"),
    intervalUsage: money("interval_usage"),
    usageUnit: text("usage_unit"),
    startsOn: date("starts_on").notNull(),
    lastPerformedOn: date("last_performed_on"),
    lastPerformedUsage: money("last_performed_usage"),
    nextDueOn: date("next_due_on"),
    nextDueUsage: money("next_due_usage"),
    vendorPartyId: uuid("vendor_party_id"),
    estimatedCost: money("estimated_cost"),
    leadDays: integer("lead_days").notNull().default(14),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("asset_maintenance_schedules_org_id_id_unique").on(t.orgId, t.id),
    index("asset_maintenance_schedules_asset").on(t.orgId, t.assetId),
    check(
      "asset_maintenance_schedules_interval",
      sql`${t.intervalMonths} is not null or ${t.intervalUsage} is not null`,
    ),
  ],
);

/** Maintenance work performed; non-posting, linked to the bill line that paid for it. */
export const assetMaintenanceRecords = pgTable(
  "asset_maintenance_records",
  {
    id: id(),
    orgId: orgRef(),
    assetId: uuid("asset_id").notNull(),
    scheduleId: uuid("schedule_id"),
    performedOn: date("performed_on").notNull(),
    usageReading: money("usage_reading"),
    description: text("description").notNull(),
    vendorPartyId: uuid("vendor_party_id"),
    cost: money("cost").notNull().default("0"),
    treatment: text("treatment", { enum: ["expense", "betterment"] }).notNull(),
    sourceDocumentId: uuid("source_document_id"),
    sourceDocumentLineId: uuid("source_document_line_id"),
    proposalId: uuid("proposal_id"),
    status: text("status", { enum: ["recorded", "cancelled"] })
      .notNull()
      .default("recorded"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("asset_maintenance_records_org_id_id_unique").on(t.orgId, t.id),
    index("asset_maintenance_records_asset").on(t.orgId, t.assetId, t.performedOn),
  ],
);

export const assetMaintenanceAlerts = pgTable(
  "asset_maintenance_alerts",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    dueKey: text("due_key").notNull(),
    stage: text("stage", { enum: ["due", "overdue"] }).notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("asset_maintenance_alerts_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_maintenance_alerts_once").on(t.orgId, t.scheduleId, t.dueKey, t.stage),
  ],
);

/** Insurance policies covering one or more assets of one legal entity. */
export const assetInsurancePolicies = pgTable(
  "asset_insurance_policies",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    insurerPartyId: uuid("insurer_party_id").notNull(),
    policyNumber: text("policy_number").notNull(),
    description: text("description"),
    coverageStartsOn: date("coverage_starts_on").notNull(),
    coverageEndsOn: date("coverage_ends_on").notNull(),
    premium: money("premium").notNull().default("0"),
    deductible: money("deductible").notNull().default("0"),
    currency: text("currency").notNull(),
    renewalLeadDays: integer("renewal_lead_days").notNull().default(30),
    status: text("status", { enum: ["active", "cancelled"] })
      .notNull()
      .default("active"),
    renewsPolicyId: uuid("renews_policy_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("asset_insurance_policies_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_insurance_policies_identity").on(
      t.orgId,
      t.insurerPartyId,
      t.policyNumber,
      t.coverageStartsOn,
    ),
    check("asset_insurance_policies_period", sql`${t.coverageEndsOn} >= ${t.coverageStartsOn}`),
  ],
);

export const assetInsuranceCoverages = pgTable(
  "asset_insurance_coverages",
  {
    id: id(),
    orgId: orgRef(),
    policyId: uuid("policy_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    insuredValue: money("insured_value").notNull(),
    replacementValue: money("replacement_value"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("asset_insurance_coverages_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_insurance_coverages_once").on(t.orgId, t.policyId, t.assetId),
    index("asset_insurance_coverages_asset").on(t.orgId, t.assetId),
  ],
);

export const assetInsuranceAlerts = pgTable(
  "asset_insurance_alerts",
  {
    id: id(),
    orgId: orgRef(),
    policyId: uuid("policy_id").notNull(),
    leadDays: integer("lead_days").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("asset_insurance_alerts_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_insurance_alerts_once").on(t.orgId, t.policyId, t.leadDays),
  ],
);
