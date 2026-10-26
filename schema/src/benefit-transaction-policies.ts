import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";
import { users } from "./extension";
import { items } from "./documents";
import { segmentDefinitions } from "./segments";
import { orgs } from "./core";
import { benefitPrograms } from "./benefits-programs";

/** Typed transaction rules inherit the native program lifecycle and effective dates. */
const ruleColumns = () => ({
  id: id(),
  orgId: orgRef(),
  programId: uuid("program_id").notNull(),
  reason: text("reason").notNull(),
  ...auditColumns,
  createdBy: uuid("created_by").notNull(),
  updatedBy: uuid("updated_by").notNull(),
});
export const benefitTransactionPolicies = pgTable(
  "hrm_benefit_transaction_policies",
  {
    ...ruleColumns(),
    documentKind: text("document_kind").notNull(),
    groupingSegmentId: uuid("grouping_segment_id"),
    dateBasis: text("date_basis").notNull(),
    unassignedShare: text("unassigned_share").notNull().default("refuse"),
    rounding: text("rounding").notNull().default("per_group"),
    capPercent: numeric("cap_percent", { precision: 19, scale: 4 }),
    capProjectTypeId: uuid("cap_project_type_id"),
  },
  (t) => [
    uniqueIndex("hrm_benefit_transaction_policies_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_transaction_policies_program_unique").on(t.orgId, t.programId),
    foreignKey({
      columns: [t.orgId, t.groupingSegmentId],
      foreignColumns: [segmentDefinitions.orgId, segmentDefinitions.id],
    }),
    check(
      "hrm_benefit_transaction_policies_kind",
      sql`${t.documentKind} IN ('sales_order','customer_invoice','field_ticket','quote')`,
    ),
    check(
      "hrm_benefit_transaction_policies_date_basis",
      sql`${t.dateBasis} IN ('document_date','work_date')`,
    ),
    check(
      "hrm_benefit_transaction_policies_unassigned_share",
      sql`${t.unassignedShare} IN ('refuse','forfeit')`,
    ),
    check(
      "hrm_benefit_transaction_policies_rounding",
      sql`${t.rounding} IN ('per_group','per_recipient')`,
    ),
    check(
      "hrm_benefit_transaction_policies_cap",
      sql`(${t.capPercent} IS NULL AND ${t.capProjectTypeId} IS NULL) OR (${t.capPercent} IS NOT NULL AND ${t.capPercent} >= 0 AND ${t.capPercent} <= 100)`,
    ),
    foreignKey({
      columns: [t.orgId, t.programId],
      foreignColumns: [benefitPrograms.orgId, benefitPrograms.id],
    }),
    foreignKey({ columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [users.orgId, users.id] }),
    foreignKey({ columns: [t.orgId, t.updatedBy], foreignColumns: [users.orgId, users.id] }),
    check(
      "hrm_benefit_transaction_policies_reason",
      sql`length(btrim(${t.reason})) BETWEEN 1 AND 2000`,
    ),
  ],
);
export const benefitTransactionItems = pgTable(
  "hrm_benefit_transaction_items",
  {
    ...ruleColumns(),
    itemId: uuid("item_id").notNull(),
  },
  (t) => [
    uniqueIndex("hrm_benefit_transaction_items_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_transaction_items_item_unique").on(t.orgId, t.programId, t.itemId),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    foreignKey({
      columns: [t.orgId, t.programId],
      foreignColumns: [benefitPrograms.orgId, benefitPrograms.id],
    }),
    foreignKey({
      columns: [t.orgId, t.programId],
      foreignColumns: [benefitTransactionPolicies.orgId, benefitTransactionPolicies.programId],
    }),
    foreignKey({ columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [users.orgId, users.id] }),
    foreignKey({ columns: [t.orgId, t.updatedBy], foreignColumns: [users.orgId, users.id] }),
    check(
      "hrm_benefit_transaction_items_reason",
      sql`length(btrim(${t.reason})) BETWEEN 1 AND 2000`,
    ),
  ],
);
export const benefitTransactionPositions = pgTable(
  "hrm_benefit_transaction_positions",
  {
    ...ruleColumns(),
    positionKey: text("position_key").notNull(),
    name: text("name").notNull(),
    weight: numeric("weight", { precision: 19, scale: 4 }).notNull(),
    recipientSource: text("recipient_source").notNull().default("assignment"),
    fallbackSource: text("fallback_source"),
    fallbackOnlyWhenContextAbsent: boolean("fallback_only_when_context_absent")
      .notNull()
      .default(false),
  },
  (t) => [
    uniqueIndex("hrm_benefit_transaction_positions_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_transaction_positions_position_unique").on(
      t.orgId,
      t.programId,
      t.positionKey,
    ),
    check("hrm_benefit_transaction_positions_weight", sql`${t.weight}>0`),
    check(
      "hrm_benefit_transaction_positions_key",
      sql`length(btrim(${t.positionKey})) BETWEEN 1 AND 120`,
    ),
    check(
      "hrm_benefit_transaction_positions_name",
      sql`length(btrim(${t.name})) BETWEEN 1 AND 200`,
    ),
    foreignKey({
      columns: [t.orgId, t.programId],
      foreignColumns: [benefitPrograms.orgId, benefitPrograms.id],
    }),
    foreignKey({
      columns: [t.orgId, t.programId],
      foreignColumns: [benefitTransactionPolicies.orgId, benefitTransactionPolicies.programId],
    }),
    foreignKey({ columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [users.orgId, users.id] }),
    foreignKey({ columns: [t.orgId, t.updatedBy], foreignColumns: [users.orgId, users.id] }),
    check(
      "hrm_benefit_transaction_positions_context_fallback",
      sql`NOT ${t.fallbackOnlyWhenContextAbsent} OR (${t.recipientSource} <> 'assignment' AND ${t.fallbackSource} IS NOT NULL)`,
    ),
    check(
      "hrm_benefit_transaction_positions_reason",
      sql`length(btrim(${t.reason})) BETWEEN 1 AND 2000`,
    ),
  ],
);
export const benefitTransactionLimits = pgTable(
  "hrm_benefit_transaction_limits",
  {
    ...ruleColumns(),
    groupId: uuid("group_id").notNull(),
    limitKind: text("limit_kind").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }),
  },
  (t) => [
    uniqueIndex("hrm_benefit_transaction_limits_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_transaction_limits_group_unique").on(t.orgId, t.programId, t.groupId),
    check(
      "hrm_benefit_transaction_limits_amount",
      sql`(${t.limitKind}='none' AND ${t.amount} IS NULL) OR (${t.limitKind}='amount' AND ${t.amount} IS NOT NULL AND ${t.amount}>=0)`,
    ),
    foreignKey({
      columns: [t.orgId, t.programId],
      foreignColumns: [benefitPrograms.orgId, benefitPrograms.id],
    }),
    foreignKey({
      columns: [t.orgId, t.programId],
      foreignColumns: [benefitTransactionPolicies.orgId, benefitTransactionPolicies.programId],
    }),
    foreignKey({ columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [users.orgId, users.id] }),
    foreignKey({ columns: [t.orgId, t.updatedBy], foreignColumns: [users.orgId, users.id] }),
    check(
      "hrm_benefit_transaction_limits_reason",
      sql`length(btrim(${t.reason})) BETWEEN 1 AND 2000`,
    ),
  ],
);
export const benefitTransactionResponsibilities = pgTable(
  "hrm_benefit_transaction_responsibilities",
  {
    ...ruleColumns(),
    positionKey: text("position_key").notNull(),
    groupId: uuid("group_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
  },
  (t) => [
    uniqueIndex("hrm_benefit_transaction_responsibilities_org_id_unique").on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.programId, t.positionKey],
      foreignColumns: [
        benefitTransactionPositions.orgId,
        benefitTransactionPositions.programId,
        benefitTransactionPositions.positionKey,
      ],
    }),
    check(
      "hrm_benefit_transaction_responsibilities_dates",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo}>=${t.effectiveFrom}`,
    ),
    foreignKey({
      columns: [t.orgId, t.programId],
      foreignColumns: [benefitPrograms.orgId, benefitPrograms.id],
    }),
    foreignKey({
      columns: [t.orgId, t.programId, t.groupId],
      foreignColumns: [
        benefitTransactionLimits.orgId,
        benefitTransactionLimits.programId,
        benefitTransactionLimits.groupId,
      ],
    }),
    foreignKey({ columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({ columns: [t.orgId, t.createdBy], foreignColumns: [users.orgId, users.id] }),
    foreignKey({ columns: [t.orgId, t.updatedBy], foreignColumns: [users.orgId, users.id] }),
    check(
      "hrm_benefit_transaction_responsibilities_reason",
      sql`length(btrim(${t.reason})) BETWEEN 1 AND 2000`,
    ),
  ],
);
