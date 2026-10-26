import { date, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";
export const subscriptionRenewalPolicies = pgTable("subscription_renewal_policies", {
  id: id(),
  orgId: orgRef(),
  subscriptionId: uuid("subscription_id").notNull(),
  subsidiaryId: uuid("subsidiary_id").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to").notNull(),
  ownerId: uuid("owner_id").notNull(),
  reminderDays: jsonb("reminder_days").$type<{ days: number }[]>().notNull(),
  generationLeadDays: integer("generation_lead_days").notNull(),
  documentKind: text("document_kind", { enum: ["quote", "sales_order"] }).notNull(),
  upliftPercent: money("uplift_percent").notNull(),
  termMonths: integer("term_months").notNull(),
  reason: text("reason").notNull(),
  ...auditColumns,
});
export const subscriptionRenewalOccurrences = pgTable("subscription_renewal_occurrences", {
  id: id(),
  orgId: orgRef(),
  policyId: uuid("policy_id").notNull(),
  subscriptionId: uuid("subscription_id").notNull(),
  termEndsOn: date("term_ends_on").notNull(),
  occurrence: text("occurrence").notNull(),
  documentId: uuid("document_id"),
  notificationId: uuid("notification_id"),
  snapshot: jsonb("snapshot").notNull(),
  actorId: uuid("actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const recognitionControlEvents = pgTable("recognition_control_events", {
  id: id(),
  orgId: orgRef(),
  obligationId: uuid("obligation_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  action: text("action", { enum: ["hold", "release", "deliver"] }).notNull(),
  reason: text("reason").notNull(),
  effectiveOn: date("effective_on"),
  evidence: text("evidence"),
  beforeState: jsonb("before_state").notNull(),
  afterState: jsonb("after_state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
