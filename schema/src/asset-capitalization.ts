import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Effective-dated capitalization rules (migration 0688). A posted purchase
 * line whose account, item or item category matches an active rule on its
 * posting date, at or above the rule's minimum amount, becomes an asset
 * proposal. Matching terms are immutable; policy changes end one rule and
 * start another.
 */
export const assetCapitalizationRules = pgTable(
  "asset_capitalization_rules",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    matchKind: text("match_kind", { enum: ["account", "item", "item_category"] }).notNull(),
    accountId: uuid("account_id"),
    itemId: uuid("item_id"),
    itemCategory: text("item_category"),
    assetCategoryId: uuid("asset_category_id"),
    minimumAmount: money("minimum_amount").notNull().default("0"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("asset_capitalization_rules_org_id_id_unique").on(t.orgId, t.id),
    index("asset_capitalization_rules_org_window").on(t.orgId, t.effectiveFrom),
    check("asset_capitalization_rules_minimum", sql`${t.minimumAmount} >= 0`),
    check(
      "asset_capitalization_rules_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** One accepted proposal operation and its reclassification journal. */
export const assetProposalAcceptances = pgTable(
  "asset_proposal_acceptances",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    operation: text("operation", {
      enum: ["asset", "split", "merge", "component", "cip"],
    }).notNull(),
    acceptedOn: date("accepted_on").notNull(),
    reclassEntryId: uuid("reclass_entry_id"),
    status: text("status", { enum: ["posted", "reversed"] })
      .notNull()
      .default("posted"),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    reversalEntryId: uuid("reversal_entry_id"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by"),
    reversalReason: text("reversal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("asset_proposal_acceptances_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_proposal_acceptances_idempotency").on(t.orgId, t.idempotencyKey),
  ],
);

/** A posted GL line proposed for capitalization, one per source journal line. */
export const assetProposals = pgTable(
  "asset_proposals",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    origin: text("origin", { enum: ["rule", "manual"] })
      .notNull()
      .default("rule"),
    ruleId: uuid("rule_id"),
    sourceEntryId: uuid("source_entry_id").notNull(),
    sourceLineId: uuid("source_line_id").notNull(),
    sourceDocumentId: uuid("source_document_id"),
    sourceDocumentLineId: uuid("source_document_line_id"),
    accountId: uuid("account_id").notNull(),
    itemId: uuid("item_id"),
    vendorPartyId: uuid("vendor_party_id"),
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    description: text("description"),
    quantity: numeric("quantity", { precision: 28, scale: 8 }),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    postingDate: date("posting_date").notNull(),
    suggestedCategoryId: uuid("suggested_category_id"),
    status: text("status", { enum: ["pending", "accepted", "rejected", "voided"] })
      .notNull()
      .default("pending"),
    acceptanceId: uuid("acceptance_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    resolutionReason: text("resolution_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("asset_proposals_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_proposals_source_line_unique").on(t.orgId, t.sourceLineId),
    index("asset_proposals_org_status").on(t.orgId, t.status, t.postingDate),
    index("asset_proposals_source_entry").on(t.orgId, t.sourceEntryId),
    check("asset_proposals_amount", sql`${t.amount} > 0`),
  ],
);

/** Lineage from accepted proposals to the assets or construction costs they became. */
export const assetProposalAllocations = pgTable(
  "asset_proposal_allocations",
  {
    id: id(),
    orgId: orgRef(),
    acceptanceId: uuid("acceptance_id").notNull(),
    proposalId: uuid("proposal_id").notNull(),
    assetId: uuid("asset_id"),
    assetNumber: text("asset_number").notNull(),
    cipCostId: uuid("cip_cost_id"),
    targetAccountId: uuid("target_account_id").notNull(),
    amount: money("amount").notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("asset_proposal_allocations_org_id_id_unique").on(t.orgId, t.id),
    index("asset_proposal_allocations_acceptance").on(t.orgId, t.acceptanceId),
    index("asset_proposal_allocations_proposal").on(t.orgId, t.proposalId),
  ],
);

/** A posted GL line on a construction-in-progress account linked to one CIP record. */
export const assetCipCosts = pgTable(
  "asset_cip_costs",
  {
    id: id(),
    orgId: orgRef(),
    cipAssetId: uuid("cip_asset_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    sourceEntryId: uuid("source_entry_id").notNull(),
    sourceLineId: uuid("source_line_id").notNull(),
    sourceDocumentId: uuid("source_document_id"),
    accountId: uuid("account_id").notNull(),
    projectId: uuid("project_id"),
    amount: money("amount").notNull(),
    postingDate: date("posting_date").notNull(),
    memo: text("memo"),
    status: text("status", { enum: ["linked", "unlinked"] })
      .notNull()
      .default("linked"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    linkedBy: uuid("linked_by").notNull(),
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
    unlinkedBy: uuid("unlinked_by"),
    unlinkReason: text("unlink_reason"),
  },
  (t) => [
    uniqueIndex("asset_cip_costs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_cip_costs_live_source_line")
      .on(t.orgId, t.sourceLineId)
      .where(sql`${t.status} = 'linked'`),
    index("asset_cip_costs_cip").on(t.orgId, t.cipAssetId, t.status),
    check("asset_cip_costs_amount", sql`${t.amount} <> 0`),
  ],
);

/** A governed move of construction-in-progress cost into assets and expense. */
export const assetCipCapitalizations = pgTable(
  "asset_cip_capitalizations",
  {
    id: id(),
    orgId: orgRef(),
    cipAssetId: uuid("cip_asset_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    capitalizedOn: date("capitalized_on").notNull(),
    entryId: uuid("entry_id").notNull(),
    capitalizedAmount: money("capitalized_amount").notNull(),
    expensedAmount: money("expensed_amount").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: ["posted", "reversed"] })
      .notNull()
      .default("posted"),
    reversalEntryId: uuid("reversal_entry_id"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by"),
    reversalReason: text("reversal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("asset_cip_capitalizations_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_cip_capitalizations_idempotency").on(t.orgId, t.idempotencyKey),
    index("asset_cip_capitalizations_cip").on(t.orgId, t.cipAssetId, t.capitalizedOn),
  ],
);

export const assetCipCapitalizationLines = pgTable(
  "asset_cip_capitalization_lines",
  {
    id: id(),
    orgId: orgRef(),
    capitalizationId: uuid("capitalization_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    kind: text("kind", { enum: ["asset", "component", "expense"] }).notNull(),
    assetId: uuid("asset_id"),
    assetNumber: text("asset_number"),
    parentAssetId: uuid("parent_asset_id"),
    targetAccountId: uuid("target_account_id").notNull(),
    amount: money("amount").notNull(),
    memo: text("memo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("asset_cip_capitalization_lines_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("asset_cip_capitalization_lines_number").on(
      t.orgId,
      t.capitalizationId,
      t.lineNumber,
    ),
    check("asset_cip_capitalization_lines_amount", sql`${t.amount} > 0`),
  ],
);
