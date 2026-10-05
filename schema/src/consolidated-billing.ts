import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, orgRef } from "./helpers";
import { orgs } from "./core";
import { parties } from "./parties";
import { subsidiaries } from "./subsidiaries";
import { documents } from "./documents";

/**
 * Payer hierarchies and consolidated billing: a service-to child party bills
 * through a bill-to recipient to an AR payer, and consolidation groups roll
 * a period's draft charges into one invoice per payer. Gated by the
 * `consolidatedBilling` feature; resolution pins the parties on the billing
 * date so relationship changes never reinterpret posted history.
 */
export const consolidationGroups = pgTable(
  "consolidation_groups",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    payerPartyId: uuid("payer_party_id").notNull(),
    billingSubsidiaryId: uuid("billing_subsidiary_id"),
    cadence: text("cadence", { enum: ["weekly", "monthly"] })
      .notNull()
      .default("monthly"),
    cutoffDay: integer("cutoff_day").notNull().default(1),
    grouping: text("grouping", { enum: ["by_child", "by_subscription", "by_product"] })
      .notNull()
      .default("by_child"),
    template: text("template"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("consolidation_groups_org_payer").on(t.orgId, t.payerPartyId),
    check(
      "consolidation_groups_cutoff_valid",
      sql`${t.cutoffDay} BETWEEN 1 AND 28`,
    ),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [orgs.id],
      name: "consolidation_groups_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.payerPartyId],
      foreignColumns: [parties.orgId, parties.id],
      name: "consolidation_groups_payer_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.billingSubsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
      name: "consolidation_groups_billing_subsidiary_org_fk",
    }),
  ],
);

export const customerBillingRelationships = pgTable(
  "customer_billing_relationships",
  {
    id: id(),
    orgId: orgRef(),
    childPartyId: uuid("child_party_id").notNull(),
    billToPartyId: uuid("bill_to_party_id").notNull(),
    payerPartyId: uuid("payer_party_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    consolidationGroupId: uuid("consolidation_group_id"),
    ...auditColumns,
  },
  (t) => [
    index("customer_billing_relationships_child_window").on(
      t.orgId,
      t.childPartyId,
      t.effectiveFrom,
    ),
    check(
      "customer_billing_relationships_window_valid",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    check(
      "customer_billing_relationships_redirects_somewhere",
      sql`${t.childPartyId} <> ${t.billToPartyId} OR ${t.childPartyId} <> ${t.payerPartyId}`,
    ),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [orgs.id],
      name: "customer_billing_relationships_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.childPartyId],
      foreignColumns: [parties.orgId, parties.id],
      name: "customer_billing_relationships_child_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.billToPartyId],
      foreignColumns: [parties.orgId, parties.id],
      name: "customer_billing_relationships_bill_to_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.payerPartyId],
      foreignColumns: [parties.orgId, parties.id],
      name: "customer_billing_relationships_payer_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.consolidationGroupId],
      foreignColumns: [consolidationGroups.orgId, consolidationGroups.id],
      name: "customer_billing_relationships_group_org_fk",
    }),
  ],
);

/**
 * Consolidation run guard: exactly one invoice per group, period, currency
 * and billing entity. A re-run replays the committed invoice.
 */
export const consolidationRuns = pgTable(
  "consolidation_runs",
  {
    id: id(),
    orgId: orgRef(),
    groupId: uuid("group_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    currency: currencyCode().notNull(),
    billingSubsidiaryId: uuid("billing_subsidiary_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    index("consolidation_runs_group_period").on(
      t.orgId,
      t.groupId,
      t.periodStart,
      t.periodEnd,
    ),
    check(
      "consolidation_runs_period_valid",
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
    foreignKey({
      columns: [t.orgId],
      foreignColumns: [orgs.id],
      name: "consolidation_runs_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.groupId],
      foreignColumns: [consolidationGroups.orgId, consolidationGroups.id],
      name: "consolidation_runs_group_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.billingSubsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
      name: "consolidation_runs_billing_subsidiary_org_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [documents.orgId, documents.id],
      name: "consolidation_runs_invoice_org_fk",
    }),
  ],
);
